import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDiceOp } from "../dice/resolve.ts";
import type { Actor, Effect, LogEntry, RollRequest, RoomState, Viewer } from "../model.ts";
import { canApply } from "../permissions.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { pendingSaves } from "../rules/saveEnds.ts";
import { DM, P1, actor, chance, character, effect, entry, env, int, pick, rng, room, token } from "../testutil.ts";

/**
 * Save ends over many random sequences (docs/design-v1-roll-options.md 11,
 * "Randomized, save ends"): turn ends, asks from two DM devices that may
 * each hold a stale view, typed and rolled answers, an ask to change an
 * answer written into the state as doc 4's `roll.change` will write it,
 * effect removals and new effects, Accept failure, Dismiss, the live card's
 * Close and Close all answered, a close interrupted by a dropped socket and
 * sent again, Previous, and reloads. The invariants, checked after every step:
 *
 * 1. No two open requests share an occurrence, and each asks one that is
 *    still pending.
 * 2. A pass removes the effect at most once.
 * 3. A resolved or dismissed occurrence never comes back.
 * 4. No closed request leaves its occurrence pending.
 * 5. A request closes only for a reason: a pass, the effect's removal or a
 *    turn end that replaces or takes back its occurrence, the DM's close
 *    (Accept failure, Dismiss, Close, Close all answered) or the save taken
 *    off. A fail never closes it.
 * 6. A reload rebuilds exactly the pending occurrences, each named by a
 *    line of its turn end.
 */

const SEEDS = 2_000;
const STEPS = 30;
const BREE = { characterId: "bree" } as const;
const GOB = { tokenId: "gob" } as const;
type Creature = typeof BREE | typeof GOB;

function actorOf(state: RoomState, c: Creature): Actor {
  return "characterId" in c ? state.characters.bree!.actor : (state.tokens.gob!.actor as { inline: Actor }).inline;
}

/** Bree (p1) and Goblin 2 in a fight, each Frightened with a Wisdom save that ends it. */
function world(): RoomState {
  const fx = (id: string): Effect => effect(id, { key: "frightened", save: { ability: "wis", dc: 12 } });
  return room({
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"], actor: actor({ effects: [fx("bfx0")] }) }) },
    tokens: {
      gob: token("gob", { kind: "monster", name: "Goblin 2", actor: { inline: actor({ effects: [fx("gfx0")] }) } }),
      breeTok: token("breeTok", { kind: "pc", name: "Bree", ownerIds: ["p1"], actor: { ref: "bree" } }),
    },
    encounter: { rev: 0, round: 1, activeEntryId: "e-gob", started: true, entries: [entry("e-gob", { tokenId: "gob", value: 20, tieOrder: 0 }), entry("e-bree", { characterId: "bree", value: 10, tieOrder: 1 })] },
  });
}

type Step = { op: Op; who: Viewer; faces?: number[]; pre?: (s: RoomState) => RoomState; again?: true };

/** One random step, built from what a device last saw, which may be stale. */
function step(r: () => number, state: RoomState, views: RoomState[], n: number): Step | null {
  const device = int(r, 0, views.length - 1);
  const view = views[device]!;
  const kind = pick(r, ["next", "next", "prev", "ask", "ask", "type", "roll", "change", "remove", "readd", "accept", "dismiss", "close", "closeAll", "dropped", "reload", "unsave"] as const);
  const open = Object.values(state.rolls).filter((q) => q.ends);
  switch (kind) {
    case "next":
      return { op: { t: "encounter.next" }, who: DM };
    case "prev":
      return { op: { t: "encounter.prev" }, who: DM };
    case "ask": {
      // Only a player's creature is asked. A stale view may name an old or settled occurrence, or one another device asked.
      const pending = pendingSaves(view).filter((p) => "characterId" in p.target && (chance(r, 0.3) || !p.request));
      const p = pending.length > 0 ? pick(r, pending) : undefined;
      if (!p) return null;
      return {
        op: {
          t: "roll.ask",
          request: { id: `r${n}`, test: { kind: "save", choices: [{ ability: "wis" }] }, dc: 12, dcShown: chance(r, 0.5), resultShown: true, cause: "saveEnds", ends: { effect: p.effect.id, occurrence: p.effect.due.id }, targets: [BREE] },
        },
        who: DM,
      };
    }
    case "type": {
      const q = open.length > 0 ? pick(r, open) : undefined;
      if (!q) return null;
      return { op: { t: "roll.answer", rollId: q.id, target: BREE, total: int(r, 3, 20), tag: `t${n}` }, who: chance(r, 0.8) ? P1 : DM };
    }
    case "roll": {
      const q = open.length > 0 ? pick(r, open) : undefined;
      if (!q) return null;
      return { op: { t: "roll.dice", tag: `t${n}`, rollId: q.id, target: BREE, bonus: 0, ...(chance(r, 0.3) ? { unanswered: true as const } : {}) }, who: chance(r, 0.7) ? P1 : DM, faces: [int(r, 1, 20)] };
    }
    case "change": {
      // A player asks to change a final answer: doc 4's `roll.change` writes this ask on the target.
      const q = open.find((x) => x.targets[0]!.tag !== undefined && x.targets[0]!.change === undefined);
      if (!q) return null;
      const pre = (s: RoomState) => {
        const request = s.rolls[q.id];
        const t = request?.targets[0];
        if (!request || !t?.tag) return s;
        return { ...s, rolls: { ...s.rolls, [q.id]: { ...request, targets: [{ ...t, change: { kind: "heroic", on: t.tag } }] } } } as RoomState;
      };
      return { op: { t: "log.chat", text: "Can I use Heroic Inspiration?" }, who: P1, pre };
    }
    case "remove": {
      const c = pick(r, [BREE, GOB]);
      const fx = actorOf(view, c).effects.find((e) => e.key === "frightened");
      if (!fx) return null;
      return { op: { t: "actor.effect.remove", target: c, effectId: fx.id }, who: DM };
    }
    case "readd": {
      const c = pick(r, [BREE, GOB]);
      if (actorOf(state, c).effects.some((e) => e.key === "frightened")) return null;
      return { op: { t: "actor.effect.add", target: c, effect: { id: `fx${n}`, key: "frightened", save: { ability: "wis", dc: 12 } } }, who: DM };
    }
    case "accept":
    case "dismiss": {
      const pending = pendingSaves(view);
      const p = pending.length > 0 ? pick(r, pending) : undefined;
      if (!p) return null;
      const settle = kind === "accept" ? ("resolved" as const) : ("dismissed" as const);
      // With a request the card closes it, which settles the occurrence. Without one it settles the occurrence itself.
      if (p.request) return { op: { t: "roll.close", rollIds: [p.request.id], settle }, who: DM };
      return { op: { t: "actor.saveDue", target: p.target, effectId: p.effect.id, due: p.effect.due.id, state: settle }, who: DM };
    }
    case "close": {
      const mine = Object.values(view.rolls).filter((q) => q.ends);
      const q = mine.length > 0 ? pick(r, mine) : undefined;
      return q ? { op: { t: "roll.close", rollIds: [q.id] }, who: DM } : null;
    }
    case "closeAll":
      return { op: { t: "roll.close", rollIds: Object.keys(view.rolls), ifSettled: true }, who: DM };
    case "dropped": {
      // The socket drops after the close was sent: the device sends it again, and the second must change nothing.
      const mine = Object.values(view.rolls).filter((q) => q.ends);
      const q = mine.length > 0 ? pick(r, mine) : undefined;
      return q ? { op: { t: "roll.close", rollIds: [q.id], ...(chance(r, 0.5) ? { settle: "resolved" as const } : {}) }, who: DM, again: true } : null;
    }
    case "reload":
      views[device] = state;
      return null;
    case "unsave": {
      const c = pick(r, [BREE, GOB]);
      const fx = actorOf(view, c).effects.find((e) => e.save);
      return fx ? { op: { t: "actor.effect.update", target: c, effectId: fx.id, patch: { save: null } }, who: DM } : null;
    }
  }
}

let seq = 0;
function run(state: RoomState, s: Step): { state: RoomState; log: LogEntry[] } | null {
  if (!canApply(s.op, s.who, state, { canUseAsset: () => true }).ok) return null;
  let op = s.op;
  if (op.t === "roll.dice") {
    const faces = [...(s.faces ?? [])];
    const resolved = resolveDiceOp(op, state, { draw: () => faces.shift() ?? 10, batch: "AbCdEfGhIjKlMnOp" });
    if (!resolved.ok) return null;
    op = resolved.op;
  }
  const r = applyOp(state, op, s.who, env(++seq));
  return r.ok ? { state: r.state, log: r.log } : null;
}

const effectsOf = (state: RoomState) => [
  ...actorOf(state, BREE).effects.map((e) => ({ c: BREE as Creature, e })),
  ...actorOf(state, GOB).effects.map((e) => ({ c: GOB as Creature, e })),
];
const passed = (q: RollRequest) => {
  const t = q.targets[0]!;
  return t.result === "pass" || (t.result === undefined && t.total !== undefined && q.dc !== undefined && t.total >= q.dc);
};

test("save ends: one request per occurrence, a pass removes once, settled stays settled, closes only for a reason", () => {
  const reached: Record<string, number> = {};
  const count = (k: string) => (reached[k] = (reached[k] ?? 0) + 1);
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    let state = world();
    const views = [state, state];
    const settled = new Set<string>();
    const removed = new Map<string, number>();
    const lines = new Map<string, string>();
    for (let n = 0; n < STEPS; n++) {
      const at = `seed ${seed} step ${n}`;
      const s = step(r, state, views, n);
      if (!s) continue;
      const before = s.pre ? s.pre(state) : state;
      const ran = run(before, s);
      if (!ran) continue;
      let after = ran.state;
      let log = ran.log;
      if (s.again) {
        const second = run(after, s);
        if (second) {
          assert.deepEqual(effectsOf(second.state), effectsOf(after), `${at}: a close sent again changed an effect`);
          assert.deepEqual(Object.keys(second.state.rolls), Object.keys(after.rolls), `${at}: a close sent again changed the requests`);
          after = second.state;
          log = [...log, ...second.log];
        }
        count("dropped");
      }
      count(s.op.t);
      for (const e of log) {
        if (e.data?.type === "saveEnds") lines.set(e.id, e.data.effectId);
        if (e.data?.type === "effect" && e.data.action === "remove") count("removeLine");
      }

      // 1.
      const occurrences = Object.values(after.rolls).flatMap((q) => (q.ends ? [q.ends.occurrence] : []));
      assert.equal(new Set(occurrences).size, occurrences.length, `${at}: 1, two requests share an occurrence`);
      for (const q of Object.values(after.rolls)) {
        const fx = q.ends && effectsOf(after).find((x) => x.e.id === q.ends!.effect)?.e;
        if (q.ends) assert.deepEqual(fx?.due, { id: q.ends.occurrence, state: "pending" }, `${at}: 1, ${q.id} asks a save that is not waiting`);
      }

      // 2: no op removes an effect twice, and each request's pass removes its effect at most once over the run.
      const removedNow = log.filter((e) => e.data?.type === "effect" && e.data.action === "remove");
      for (const c of [BREE, GOB]) {
        const mine = removedNow.filter((e) => ("tokenId" in c ? e.data!.type === "effect" && e.data.tokenId === c.tokenId : e.data!.type === "effect" && e.data.characterId === c.characterId));
        assert.ok(mine.length <= (s.again ? 2 : 1), `${at}: 2, one op removed ${"tokenId" in c ? c.tokenId : c.characterId}'s effect twice`);
        if (s.again) assert.ok(mine.length <= 1, `${at}: 2, a close sent again removed an effect again`);
      }
      for (const q of Object.values(before.rolls)) {
        if (!q.ends || after.rolls[q.id] || effectsOf(after).some((x) => x.e.id === q.ends!.effect)) continue;
        removed.set(q.id, (removed.get(q.id) ?? 0) + 1);
        assert.equal(removed.get(q.id), 1, `${at}: 2, ${q.id} removed its effect twice`);
      }

      // 3.
      for (const { e } of effectsOf(after)) {
        if (!e.due) continue;
        if (e.due.state !== "pending") settled.add(e.due.id);
        else assert.ok(!settled.has(e.due.id), `${at}: 3, ${e.due.id} came back`);
      }

      // 4 and 5.
      for (const q of Object.values(before.rolls)) {
        if (!q.ends || after.rolls[q.id]) continue;
        const fx = effectsOf(after).find((x) => x.e.id === q.ends!.effect)?.e;
        assert.ok(!(fx?.due?.id === q.ends.occurrence && fx.due.state === "pending"), `${at}: 4, ${q.id} closed with its occurrence pending`);
        const byDm = s.op.t === "roll.close" && s.op.rollIds.includes(q.id);
        const gone = !fx;
        const moved = fx !== undefined && fx.due?.id !== q.ends.occurrence;
        const pass = s.op.t === "roll.answer" || s.op.t === "sys.dice" || s.op.t === "roll.dice";
        assert.ok(byDm || gone || moved || pass, `${at}: 5, ${q.id} closed for no reason by ${s.op.t}`);
        if (pass && !byDm && !moved) {
          assert.ok(gone, `${at}: 5, ${q.id} closed on an answer that left its effect`);
          count("passClose");
        }
        if (byDm) count("dmClose");
        if (moved && s.op.t === "encounter.next") count("nextClose");
        if (gone && s.op.t === "actor.effect.remove") count("removalClose");
      }
      // A fail leaves its request open, whatever answered it.
      for (const q of Object.values(after.rolls)) if (q.ends) assert.ok(!passed(q) || !effectsOf(after).some((x) => x.e.id === q.ends!.effect), `${at}: 5, ${q.id} open on a pass`);

      // 6.
      const cards = pendingSaves(after).map((p) => p.effect.due.id).sort();
      const want = effectsOf(after).flatMap(({ e }) => (e.save && e.due?.state === "pending" ? [e.due.id] : [])).sort();
      assert.deepEqual(cards, want, `${at}: 6, the cards are not the pending occurrences`);
      for (const p of pendingSaves(after)) assert.equal(lines.get(p.effect.due.id), p.effect.id, `${at}: 6, ${p.effect.due.id} names no turn end of its effect`);

      state = after;
    }
  }
  for (const k of ["encounter.next", "encounter.prev", "roll.ask", "roll.answer", "roll.dice", "actor.effect.remove", "actor.effect.add", "actor.saveDue", "roll.close", "actor.effect.update", "dropped", "passClose", "dmClose", "nextClose", "removalClose"]) {
    assert.ok((reached[k] ?? 0) > 0, `never reached ${k}`);
  }
});
