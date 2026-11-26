import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS } from "../limits.ts";
import type { RoomState, Token, Trap, TrapDue, TrapRig, Viewer } from "../model.ts";
import { canApply } from "../permissions.ts";
import type { Op, OpOf, RestoreEntry } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1, chance, character, env, int, pick, rng, room, token } from "../testutil.ts";

/**
 * Trap occurrences over many random sequences (docs/design/design-v1-traps.md 11,
 * "The occurrence state machine, randomized"): springings public (Thorn's
 * walks) and private (the player's hidden imps, the DM's hidden goblin),
 * Set it off on any creatures, Apply from two DM devices that may hold a
 * stale view, per creature as a page reaches them (6.2) and whole as a
 * page from before change format 66 sends it, Dismiss, Mark sprung, Do
 * its effects, a lost answer sent again under the same op, creatures the
 * DM moves to another scene and back or deletes, re-arming, and the DM's
 * undo and redo. Thorn has a second token of one character. The
 * invariants, checked after every step:
 *
 * 1. An occurrence is applied to a creature at most once, and its actions run at most once.
 * 2. It is never both applied and dismissed.
 * 3. At most 3 a trap and 10 a room, each id once.
 * 4. One no longer waiting (applied whole, dismissed or dropped) never applies.
 * 5. An undo restores the occurrence exactly, once.
 * 6. Its `hits` only shrink between undos.
 * 7. Every creature it names after a partial Apply is one the room holds and the Apply did not settle.
 * 8. No hidden occurrence outlives a partial Apply.
 * 9. A whole Apply on an occurrence that names creatures is refused.
 */

const SEEDS = 600;
const STEPS = 40;

function rig(overrides: Partial<TrapRig>): TrapRig {
  return { on: ["enter"], who: "any", floor: true, resets: "nextTurn", stops: false, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false, message: "Click.", damage: [{ formula: "1d6", type: "fire" }], ...overrides };
}

function trap(id: string, x: number, overrides: Partial<TrapRig> = {}): Trap {
  return { id, rev: 0, sceneId: "s1", name: id, zone: { cells: [{ x, y: 5, w: 1, h: 3 }] }, state: "armed", found: false, rig: rig(overrides) };
}

const CREATURES = ["thorn", "thorn2", "imp", "imp2", "gob", "bree", "ogre"];

function world(): RoomState {
  const tokens: Record<string, Token> = {
    thorn: token("thorn", { name: "Thorn", kind: "pc", ownerIds: ["p1"], actor: { ref: "c1" }, x: 0, y: 5 }),
    thorn2: token("thorn2", { name: "Thorn", kind: "pc", ownerIds: ["p1"], actor: { ref: "c1" }, x: 11, y: 9 }),
    imp: token("imp", { name: "Imp", kind: "npc", ownerIds: ["p1"], visibility: "dm", x: 0, y: 6 }),
    imp2: token("imp2", { name: "Imp", kind: "npc", ownerIds: ["p1"], visibility: "dm", x: 0, y: 7 }),
    gob: token("gob", { name: "Goblin", visibility: "dm", x: 0, y: 7 }),
    bree: token("bree", { name: "Bree", kind: "pc", ownerIds: ["p2"], x: 12, y: 9 }),
    ogre: token("ogre", { name: "Ogre", x: 13, y: 9 }),
  };
  // Four traps of three occurrences each can pass the room's ten.
  const traps = { a: trap("a", 3), b: trap("b", 6, { stops: true }), c: trap("c", 9, { usesLeft: 5, conditions: ["prone"] }), d: trap("d", 1, { actions: [{ show: { tokenId: "gob" } }] }) };
  return room({ tokens, traps, characters: { c1: character("c1", { name: "Thorn", ownerIds: ["p1"] }) } });
}

type Kind = "apply" | "dismiss" | "sprung" | "act" | "other";
/** An Apply's occurrence before it and the creatures its targets damaged, which its undo takes back. */
type Done = { kind: Kind; due?: string; before?: TrapDue; hurt?: string[]; inverse: RestoreEntry[] };

function dues(state: RoomState): (TrapDue & { trap: string })[] {
  return Object.values(state.traps).flatMap((t) => (t.rig?.due ?? []).map((d) => ({ ...d, trap: t.id })));
}

/** The creature a token shows, as actorOutcome counts it: its character, else its token. */
function creatureOf(state: RoomState, id: string): string {
  const t = state.tokens[id];
  return t && "ref" in t.actor ? `character:${t.actor.ref}` : `token:${id}`;
}

/** A group save's Apply as a DM device builds it from its view: the creatures it reached on the trap's scene, some skipped. */
function applyFrom(r: () => number, view: RoomState, due: TrapDue & { trap: string }, plan: string): OpOf<"actor.outcome"> {
  const reached = due.hits.filter((id) => view.tokens[id]?.sceneId === "s1");
  const settled = reached.filter(() => chance(r, 0.7));
  const targets = settled.filter(() => chance(r, 0.8)).map((tokenId) => ({ target: { tokenId }, amount: 1 }));
  // A page from before change format 66 settles the occurrence whole.
  if (chance(r, 0.12)) return { t: "actor.outcome", plan, trap: { trapId: due.trap, due: due.id }, targets };
  // The page adds a settled creature's other tokens, as plan.ts does where it reaches them, or the server takes them off itself.
  const others = chance(r, 0.5) ? due.hits.filter((id) => !settled.includes(id) && view.tokens[id]?.sceneId === "s1" && settled.some((s) => creatureOf(view, s) === creatureOf(view, id))) : [];
  return { t: "actor.outcome", plan, trap: { trapId: due.trap, due: due.id, tokenIds: [...settled, ...others] }, targets };
}

test("trap occurrences: applied to each creature and acted at most once, never both applied and dismissed, within their caps, cut only to creatures still waiting, through undo and redo", () => {
  let steps = 0;
  let applies = 0;
  let partials = 0;
  let hiddenPartials = 0;
  let wholeRefused = 0;
  let undoneApplies = 0;
  let fullRooms = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    let state = world();
    let seq = 10;
    // Two DM devices, each holding the room as it last heard it.
    const views: RoomState[] = [state, state];
    /** Per occurrence, how many times each creature took its damage. */
    const hurt = new Map<string, Map<string, number>>();
    const applied = new Set<string>();
    const dismissed = new Set<string>();
    const actions = new Map<string, number>();
    const undo: Done[] = [];
    const redo: Done[] = [];
    let last: { op: Op; who: Viewer } | null = null;
    let hitsBefore = new Map(dues(state).map((d) => [d.id, d.hits]));

    const run = (op: Op, who: Viewer): { ok: true; state: RoomState; inverse: RestoreEntry[] | null } | null => {
      if (!canApply(op, who, state, { canUseAsset: () => true }).ok) return null;
      const res = applyOp(state, op, who, env(seq++));
      if (!res.ok) return null;
      return { ok: true, state: res.state, inverse: res.inverse };
    };
    const where = (n: number, note: string) => `seed ${seed} step ${n} (${note})`;
    const count = (due: string, creatures: readonly string[], by: number) => {
      const each = hurt.get(due) ?? new Map<string, number>();
      for (const c of creatures) each.set(c, (each.get(c) ?? 0) + by);
      hurt.set(due, each);
    };

    for (let n = 0; n < STEPS; n++) {
      const before = state;
      const waiting = new Map(dues(before).map((d) => [d.id, d]));
      const view = views[int(r, 0, 1)]!;
      const known = dues(view);
      const someDue = known.length > 0 && chance(r, 0.9) ? pick(r, known) : { trap: pick(r, ["a", "b", "c", "d"]), id: `${int(r, 1, 99)}:0`, at: "", how: "enter" as const, by: [], hits: ["thorn"] };
      const choice = int(r, 0, 15);
      let op: Op;
      let who: Viewer = DM;
      let kind: Kind = "other";
      if (choice <= 1) {
        who = P1;
        op = { t: "token.move", tokenId: "thorn", x: int(r, 0, 11), y: 5 };
      } else if (choice === 2) {
        who = P1;
        const x = int(r, 0, 11);
        op = { t: "token.moveMany", moves: [{ tokenId: "imp", x, y: 6 }, ...(chance(r, 0.6) ? [{ tokenId: "imp2", x, y: 7 }] : [])] };
      } else if (choice === 3) {
        op = { t: "token.move", tokenId: "gob", x: int(r, 0, 11), y: 7 };
      } else if (choice <= 6) {
        op = applyFrom(r, view, someDue, `p${n}`);
        kind = "apply";
      } else if (choice === 7) {
        op = { t: "trap.settle", trapId: someDue.trap, due: someDue.id, ...(chance(r, 0.5) ? { sprung: true as const } : {}) };
        kind = op.sprung ? "sprung" : "dismiss";
      } else if (choice === 8) {
        op = { t: "trap.act", trapId: someDue.trap, due: someDue.id };
        kind = "act";
      } else if (choice === 9 && last) {
        // A lost answer: the same op sent again.
        op = last.op;
        who = last.who;
        kind = op.t === "actor.outcome" ? "apply" : op.t === "trap.settle" ? (op.sprung ? "sprung" : "dismiss") : op.t === "trap.act" ? "act" : "other";
      } else if (choice === 10 && undo.length > 0) {
        const done = undo.pop()!;
        const res = run({ t: "sys.restore", entries: done.inverse, from: "undo", deps: true }, DM);
        if (res) {
          state = res.state;
          if (done.kind === "apply") {
            applied.delete(done.due!);
            count(done.due!, done.hurt!, -1);
            undoneApplies++;
            // Invariant 5.
            const back = dues(state).filter((d) => d.id === done.due);
            assert.equal(back.length, 1, where(n, "an undone Apply brings its occurrence back once"));
            const { trap: _trap, ...exact } = back[0]!;
            assert.deepEqual(exact, done.before, where(n, "an undone Apply brings its occurrence back as it was"));
          }
          if (done.kind === "dismiss" || done.kind === "sprung") dismissed.delete(done.due!);
          if (done.kind === "act") actions.set(done.due!, (actions.get(done.due!) ?? 1) - 1);
          if (res.inverse) redo.push({ ...done, inverse: res.inverse });
        }
        check(state, n, "undo");
        hitsBefore = new Map(dues(state).map((d) => [d.id, d.hits]));
        continue;
      } else if (choice === 11 && redo.length > 0) {
        const done = redo.pop()!;
        const res = run({ t: "sys.restore", entries: done.inverse, from: "redo", deps: true }, DM);
        if (res) {
          state = res.state;
          if (done.kind === "apply") {
            assert.ok(!applied.has(done.due!) && !dismissed.has(done.due!), where(n, "a redone Apply"));
            count(done.due!, done.hurt!, 1);
            if (!dues(state).some((d) => d.id === done.due)) applied.add(done.due!);
          }
          if (done.kind === "dismiss" || done.kind === "sprung") dismissed.add(done.due!);
          if (done.kind === "act") actions.set(done.due!, (actions.get(done.due!) ?? 0) + 1);
          if (res.inverse) undo.push({ ...done, inverse: res.inverse });
        }
        check(state, n, "redo");
        hitsBefore = new Map(dues(state).map((d) => [d.id, d.hits]));
        continue;
      } else if (choice === 12) {
        op = chance(r, 0.3) ? { t: "trap.update", trapId: pick(r, ["a", "b", "c", "d"]), patch: { state: "armed", rig: { usesLeft: 3 } } } : { t: "trap.spring", trapId: pick(r, ["a", "b", "c", "d"]), tokenIds: CREATURES.filter((id) => state.tokens[id]?.sceneId === "s1" && chance(r, 0.5)) };
      } else if (choice === 13) {
        // The DM moves a creature to another scene, or back, or rarely deletes the ogre.
        const id = pick(r, CREATURES);
        op = id === "ogre" && chance(r, 0.2) ? { t: "token.delete", tokenId: id } : { t: "token.update", tokenId: id, patch: { sceneId: state.tokens[id]?.sceneId === "s1" ? "s2" : "s1" } };
      } else {
        views[int(r, 0, 1)] = state;
        continue;
      }
      const res = run(op, who);
      last = { op, who };
      const due: string | undefined = op.t === "actor.outcome" ? op.trap?.due : op.t === "trap.settle" || op.t === "trap.act" ? op.due : undefined;
      const was: (TrapDue & { trap: string }) | undefined = due === undefined ? undefined : waiting.get(due);
      if (!res) {
        if (op.t === "actor.outcome" && op.trap?.tokenIds === undefined && (was?.hits.length ?? 0) > 0) wholeRefused++;
        check(state, n, `${op.t} refused`);
        continue;
      }
      state = res.state;
      steps++;
      const after: (TrapDue & { trap: string }) | undefined = due === undefined ? undefined : dues(state).find((d) => d.id === due);
      if (due !== undefined) {
        // Invariant 4: only an occurrence still waiting is applied, dismissed or done.
        assert.ok(was !== undefined, where(n, `${op.t} of ${due}, not waiting`));
        assert.ok(!applied.has(due) && !dismissed.has(due), where(n, `${op.t} of ${due}, already settled`));
      }
      let hurtNow: string[] = [];
      if (op.t === "actor.outcome" && was) {
        // Invariant 9.
        assert.ok(op.trap?.tokenIds !== undefined || was.hits.length === 0, where(n, "a whole Apply on a named occurrence"));
        hurtNow = op.targets.map((t) => creatureOf(before, (t.target as { tokenId: string }).tokenId));
        count(due!, hurtNow, 1);
        applies++;
        if (after && after.hits.length === was.hits.length) {
          // An Apply that settles no creature it names, as one that reached none, leaves the occurrence as it was.
          assert.deepEqual(after, was, where(n, `${due} changed by an Apply that settled no one`));
        } else if (after) {
          partials++;
          if (was.hidden) hiddenPartials++;
          // Invariants 7 and 8.
          const settledNow = new Set([...(op.trap?.tokenIds ?? []).map((id) => creatureOf(before, id)), ...hurtNow]);
          for (const id of after.hits) {
            assert.ok(state.tokens[id] !== undefined, where(n, `${id} is left on ${due}, deleted`));
            assert.ok(!settledNow.has(creatureOf(state, id)), where(n, `${id} is left on ${due}, settled`));
          }
          assert.equal(after.hidden, undefined, where(n, `${due} stays hidden after a partial Apply`));
        } else applied.add(due!);
      }
      if (kind === "dismiss" || kind === "sprung") dismissed.add(due!);
      if (kind === "act") actions.set(due!, (actions.get(due!) ?? 0) + 1);
      // Springings that ran their actions as they went off.
      for (const d of dues(state)) if (!waiting.has(d.id) && d.acted) actions.set(d.id, (actions.get(d.id) ?? 0) + 1);
      if (who.role === "dm" && res.inverse) {
        const exact = was ? (({ trap: _trap, ...d }) => d)(was) : undefined;
        undo.push({ kind, ...(due !== undefined ? { due } : {}), ...(kind === "apply" && exact ? { before: exact, hurt: hurtNow } : {}), inverse: res.inverse });
        redo.length = 0;
      }
      check(state, n, op.t);
      // Invariant 6.
      for (const d of dues(state)) {
        const had = hitsBefore.get(d.id);
        if (had) assert.ok(d.hits.every((id) => had.includes(id)), where(n, `${op.t}: ${d.id}'s hits grew from ${had} to ${d.hits}`));
      }
      hitsBefore = new Map(dues(state).map((d) => [d.id, d.hits]));
    }

    function check(s: RoomState, n: number, note: string): void {
      const all = dues(s);
      if (all.length === LIMITS.trapDuePerRoom) fullRooms++;
      // Invariant 3.
      assert.equal(new Set(all.map((d) => d.id)).size, all.length, where(n, `${note}: an occurrence twice`));
      assert.ok(all.length <= LIMITS.trapDuePerRoom, where(n, `${note}: ${all.length} in the room`));
      for (const t of Object.values(s.traps)) assert.ok((t.rig?.due?.length ?? 0) <= LIMITS.trapDuePerTrap, where(n, `${note}: ${t.id} holds too many`));
      // Invariants 1 and 2.
      for (const [id, each] of hurt) for (const [c, times] of each) assert.ok(times <= 1, where(n, `${note}: ${c} took ${id}'s damage ${times} times`));
      for (const id of applied) assert.ok(!dismissed.has(id), where(n, `${note}: ${id} applied and dismissed`));
      for (const [id, times] of actions) assert.ok(times <= 1, where(n, `${note}: ${id}'s actions ran ${times} times`));
      for (const d of all) assert.ok(!applied.has(d.id) && !dismissed.has(d.id), where(n, `${note}: ${d.id} settled and still waiting`));
    }
  }
  assert.ok(steps > SEEDS * 10, `${steps} steps applied`);
  assert.ok(applies > 1000 && undoneApplies > 100, `${applies} applies, ${undoneApplies} undone`);
  assert.ok(partials > 150 && hiddenPartials > 50, `${partials} partial applies, ${hiddenPartials} of hidden occurrences`);
  assert.ok(wholeRefused > 150, `${wholeRefused} whole applies refused`);
  assert.ok(fullRooms > 1000, `${fullRooms} steps with the room full`);
});
