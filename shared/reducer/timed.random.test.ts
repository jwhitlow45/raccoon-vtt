import assert from "node:assert/strict";
import { test } from "node:test";
import { clockNow } from "../calendar.ts";
import { parseKey } from "../keys.ts";
import type { Actor, Effect, LogEntry, RoomState, Viewer } from "../model.ts";
import { heldClock, projectState } from "../project.ts";
import type { Op, RestoreEntry } from "../protocol.ts";
import { applyOp, type Applied } from "../reducer.ts";
import { endsDue } from "../rules/durations.ts";
import { DM, P1, chance, character, env, int, member, pick, rng, room, token } from "../testutil.ts";

/**
 * Random sequences of clock ops, time spans and counts of turns added and
 * edited, fights started, turned, taken back and ended, Stop and Undo
 * setup, and undo and redo (docs/design/design-v1-calendar-c2c3.md 11).
 * Next, a step or Set, then Previous is weighted in, and so are Undo and
 * Redo of Next and Previous with a Calendar save or a co-DM's step between,
 * and rows replaced so Previous skips rounds. Spans are "blessed" and
 * counts of turns "hasted", so the lines tell them apart. Invariants:
 *
 * 1. After every op no effect on the clock has an end the current time has
 *    reached (4.3).
 * 2. No effect holds both a count of turns and a time span.
 * 3. Each end writes exactly one expire line: an op writes one for each
 *    span it found or brought back and left out because it was due, and
 *    no other. So Previous writes none.
 * 4. Previous right after a Next, with nothing between, puts back the spans
 *    as they were before the Next.
 * 5. A player's copy holds a span's end only while their view holds that
 *    clock.
 */

const H = 3_600;
const CO_DM: Viewer = { memberId: "dm2", role: "dm" };
const HOLDERS = ["bree", "thorn", "gob"] as const;

function start(): RoomState {
  return room({
    members: { ...room().members, dm2: member("dm2", "dm") },
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }), thorn: character("thorn", { name: "Thorn", ownerIds: [] }) },
    tokens: {
      gob: token("gob"),
      "bree-t": token("bree-t", { kind: "pc", actor: { ref: "bree" }, ownerIds: ["p1"] }),
      "thorn-t": token("thorn-t", { kind: "pc", actor: { ref: "thorn" } }),
    },
  });
}

function actorOf(state: RoomState, holder: string): Actor | undefined {
  const character = state.characters[holder];
  if (character) return character.actor;
  const t = state.tokens[holder]?.actor;
  return t && "inline" in t ? t.inline : undefined;
}

const targetOf = (holder: string) => (holder === "gob" ? { tokenId: "gob" } : { characterId: holder });

/** The spans a restore writes, by holder, from its entries' values. */
function restoredSpans(entries: readonly RestoreEntry[]): Map<string, Effect[]> {
  const out = new Map<string, Effect[]>();
  for (const entry of entries) {
    const parsed = parseKey(entry.key);
    const value = entry.value as { actor?: Actor | { inline?: Actor } } | null;
    if (!value || (parsed?.kind !== "character" && parsed?.kind !== "token")) continue;
    const a = parsed.kind === "character" ? (value.actor as Actor | undefined) : (value.actor as { inline?: Actor } | undefined)?.inline;
    if (a) out.set(parsed.id, a.effects.filter((e) => e.ends));
  }
  return out;
}

function spanExpiries(log: readonly LogEntry[], holder: string): number {
  return log.filter((line) => line.data?.type === "effect" && line.data.action === "expire" && line.data.key === "blessed" && ("characterId" in line.data ? line.data.characterId : line.data.tokenId) === holder).length;
}

const idsOn = (state: RoomState, holder: string) => new Set((actorOf(state, holder)?.effects ?? []).map((e) => e.id));

let ids = 0;
function randomOp(r: () => number, state: RoomState, oldClocks: string[]): { op: Op; who: Viewer } {
  const clock = state.clock;
  const now = clock ? clockNow(clock, state.encounter) : 0;
  const holder = pick(r, HOLDERS);
  const spanSeconds = () => pick(r, [60, 120, 600, H, 8 * H, int(r, 1, 600) * 60]);
  const roll = r();
  if (roll < 0.05) {
    const id = oldClocks.length > 0 && chance(r, 0.3) ? pick(r, oldClocks) : `c${++ids}`;
    return { op: { t: "clock.start", id, at: now + int(r, -H, H), shown: chance(r, 0.6), calendar: { kind: "days" } }, who: DM };
  }
  if (roll < 0.08) return { op: { t: "clock.stop" }, who: DM };
  if (roll < 0.14) return { op: chance(r, 0.5) ? { t: "clock.update", shown: chance(r, 0.5) } : { t: "clock.update", at: now + int(r, -2 * H, 2 * H) }, who: DM };
  if (roll < 0.19) return { op: { t: "clock.set", at: now + int(r, -2 * H, 3 * H) }, who: DM };
  if (roll < 0.27) return { op: { t: "clock.advance", by: pick(r, [60, 600, H, 8 * H, int(r, 1, 120)]) }, who: DM };
  if (roll < 0.4) return { op: { t: "actor.effect.add", target: targetOf(holder), effect: { id: `s${++ids}`, key: "blessed", duration: { mode: "span", seconds: spanSeconds() } } }, who: chance(r, 0.15) ? CO_DM : DM };
  if (roll < 0.43) return { op: { t: "actor.effect.add", target: { characterId: "bree" }, effect: { id: `s${++ids}`, key: "blessed", duration: { mode: "span", seconds: spanSeconds() } } }, who: P1 };
  if (roll < 0.46) return { op: { t: "actor.effect.add", target: targetOf(holder), effect: { id: `r${++ids}`, key: "hasted", duration: { mode: "rounds", rounds: int(r, 1, 4), of: targetOf(holder) } } }, who: DM };
  const effects = actorOf(state, holder)?.effects ?? [];
  if (roll < 0.5 && effects.length > 0) {
    // A span stays "blessed" and a count of turns "hasted", so the lines keep telling them apart.
    const e = pick(r, effects);
    const duration = chance(r, 0.3) ? null : e.key === "blessed" ? { mode: "span" as const, seconds: spanSeconds() } : { mode: "rounds" as const, rounds: 2, of: targetOf(holder) };
    return { op: { t: "actor.effect.update", target: targetOf(holder), effectId: e.id, patch: { duration } }, who: DM };
  }
  if (roll < 0.53 && effects.length > 0) return { op: { t: "actor.effect.remove", target: targetOf(holder), effectId: pick(r, effects).id }, who: DM };
  if (roll < 0.57) return { op: { t: "encounter.start", entries: [{ id: `e${++ids}`, tokenId: "gob", value: 15 }, { id: `f${++ids}`, tokenId: "bree-t", value: 5 }] }, who: DM };
  if (roll < 0.75) return { op: { t: "encounter.next" }, who: DM };
  if (roll < 0.81) return { op: { t: "encounter.prev" }, who: DM };
  if (roll < 0.84) return { op: { t: "encounter.end" }, who: DM };
  if (roll < 0.87 && state.encounter) {
    // Rows replaced, so a later Previous walks back over steps whose turns have left the fight.
    const rows = state.encounter.entries.map((e) => e.id);
    if (rows.length > 0) return { op: { t: "encounter.remove", entryIds: rows }, who: DM };
    return { op: { t: "encounter.add", entries: [{ id: `g${++ids}`, tokenId: pick(r, ["gob", "thorn-t"]), value: int(r, 1, 20) }] }, who: DM };
  }
  if (roll < 0.9 && state.encounter) return { op: { t: "encounter.add", entries: [{ id: `g${++ids}`, tokenId: pick(r, ["gob", "bree-t", "thorn-t"]), value: int(r, 1, 20) }] }, who: DM };
  return { op: { t: "clock.advance", by: pick(r, [6, 60, 600]) }, who: DM };
}

type Scope = "play" | "setup";
type Step = { entries: RestoreEntry[]; from: "undo" | "redo"; scope: Scope };
type Stacks = Record<Scope, { undo: RestoreEntry[][]; redo: RestoreEntry[][] }>;

/** Start, Stop and a Calendar save are Setup steps, every other DM op a play step, each scope with stacks of its own (server/rooms/undo.ts). */
const scopeOf = (op: Op): Scope => (op.t === "clock.start" || op.t === "clock.stop" || op.t === "clock.update" ? "setup" : "play");

test("time spans keep their invariants over random play, undo and redo", () => {
  const counts = { ended: 0, prevAfterNext: 0, restores: 0, restoreEnds: 0, filtered: 0 };
  for (let seed = 1; seed <= 80; seed++) {
    const r = rng(seed * 7 + 3);
    let state = start();
    let seq = 0;
    const stacks: Stacks = { play: { undo: [], redo: [] }, setup: { undo: [], redo: [] } };
    const oldClocks: string[] = [];
    const planned: { op: Op; who: Viewer }[] = [];
    let lastWasNext: RoomState | null = null;
    // The spans the latest Next ended, and the room before it, for the count of spans a Previous left out.
    const nextEnded = new Set<string>();
    let lastNextBefore = state;
    // The span of the macro above, while its Nexts have yet to end it.
    let hunting: string | null = null;
    for (let i = 0; i < 220; i++) {
      const before = state;
      let op: Op;
      let who: Viewer = DM;
      let restoreOf: Step | null = null;
      const choice = r();
      const scope: Scope = chance(r, 0.75) ? "play" : "setup";
      const coSpan = (): { op: Op; who: Viewer } => ({ op: { t: "actor.effect.add", target: { characterId: "thorn" }, effect: { id: `s${++ids}`, key: "blessed", duration: { mode: "span", seconds: pick(r, [60, 120, 600]) } } }, who: CO_DM });
      if (planned.length > 0) ({ op, who } = planned.shift()!);
      else if (choice < 0.1 && stacks[scope].undo.length > 0) {
        restoreOf = { entries: stacks[scope].undo.pop()!, from: "undo", scope };
        op = { t: "sys.restore", entries: restoreOf.entries, from: "undo", deps: true, scope, correction: { label: "a step" } } as Op;
        // Between an Undo and its Redo, a Calendar save or a co-DM's step.
        if (chance(r, 0.4)) planned.push(chance(r, 0.5) ? { op: { t: "clock.update", at: (state.clock ? clockNow(state.clock, state.encounter) : 0) + int(r, 0, 900) }, who: DM } : coSpan());
      } else if (choice < 0.16 && stacks[scope].redo.length > 0) {
        restoreOf = { entries: stacks[scope].redo.pop()!, from: "redo", scope };
        op = { t: "sys.restore", entries: restoreOf.entries, from: "redo", deps: true, scope, correction: { label: "a step" } } as Op;
      } else if (choice < 0.19 && state.clock) {
        // A Set back, a co-DM's span, then Undo of the Set, which moves the clock past it.
        op = { t: "clock.set", at: clockNow(state.clock, state.encounter) - pick(r, [600, 3_600]) };
        planned.push(coSpan());
      } else if (choice < 0.215 && state.encounter && state.clock) {
        // A 1 minute span in a fight, the Nexts that end it, a step on, then Previous, which leaves it out.
        hunting = `s${++ids}`;
        op = { t: "actor.effect.add", target: { tokenId: "gob" }, effect: { id: hunting, key: "blessed", duration: { mode: "span", seconds: 60 } } };
        for (let n = 0; n < 22; n++) planned.push({ op: { t: "encounter.next" }, who: DM });
      } else if (choice < 0.24) {
        // Next, a step or Set, then Previous.
        const now = state.clock ? clockNow(state.clock, state.encounter) : 0;
        op = { t: "encounter.next" };
        if (chance(r, 0.3)) planned.push({ op: { t: "encounter.prev" }, who: DM });
        else planned.push({ op: chance(r, 0.5) ? { t: "clock.advance", by: pick(r, [60, 600]) } : { t: "clock.set", at: now + pick(r, [-600, 600]) }, who: DM }, { op: { t: "encounter.prev" }, who: DM });
      } else ({ op, who } = randomOp(r, state, oldClocks));
      const result = applyOp(state, op, who, env(++seq));
      if (!result.ok) {
        lastWasNext = null;
        continue;
      }
      const applied: Applied = result;
      state = applied.state;
      const where = `seed ${seed} step ${i} ${op.t}`;
      if (op.t === "encounter.next") {
        nextEnded.clear();
        lastNextBefore = before;
      }
      if (before.clock && !oldClocks.includes(before.clock.id)) oldClocks.push(before.clock.id);

      const clock = state.clock;
      const now = clock ? clockNow(clock, state.encounter) : 0;
      for (const holder of HOLDERS) {
        const effects = actorOf(state, holder)?.effects ?? [];
        for (const e of effects) {
          // Invariant 1.
          if (clock) assert.equal(endsDue(e, clock, now), false, `${where}: ${holder} ${e.id} due`);
          // Invariant 2.
          assert.ok(e.duration === undefined || e.ends === undefined, `${where}: both`);
        }
        // Invariant 3.
        const after = new Set(effects.map((e) => e.id));
        // A restore that writes the creature puts its effects as its value holds them, so those are what the scan may
        // end. A redo of a step that ended a span lacks it, and its line is the step's.
        const restored = op.t === "sys.restore" ? restoredSpans(op.entries).get(holder) : undefined;
        const candidates = new Map<string, Effect>();
        for (const e of restored ?? actorOf(before, holder)?.effects ?? []) if (e.ends) candidates.set(e.id, e);
        const due = [...candidates.values()].filter((e) => !after.has(e.id) && clock !== undefined && clock !== null && endsDue(e, clock, now));
        assert.equal(spanExpiries(applied.log, holder), due.length, `${where}: ${holder} lines`);
        counts.ended += due.length;
        if (op.t === "sys.restore") counts.restoreEnds += due.length;
        if (op.t === "encounter.next") for (const e of due) nextEnded.add(e.id);
        if (op.t === "encounter.prev") counts.filtered += [...nextEnded].filter((id) => (actorOf(before, holder)?.effects ?? []).every((e) => e.id !== id) && !after.has(id) && idsOn(lastNextBefore, holder).has(id)).length;
      }
      // Invariant 4.
      if (op.t === "encounter.prev" && lastWasNext && before.encounter && state.encounter) {
        const unmoved = lastWasNext.clock?.t === before.clock?.t && lastWasNext.clock?.id === before.clock?.id;
        if (unmoved && state.encounter.round === lastWasNext.encounter?.round && state.encounter.activeEntryId === lastWasNext.encounter.activeEntryId) {
          counts.prevAfterNext++;
          for (const holder of HOLDERS) {
            const spans = (s: RoomState) => (actorOf(s, holder)?.effects ?? []).filter((e) => e.ends);
            assert.deepEqual(spans(state), spans(lastWasNext), `${where}: ${holder} spans after Previous`);
          }
        }
      }
      lastWasNext = op.t === "encounter.next" ? before : null;
      if (hunting !== null && op.t === "encounter.next" && !idsOn(state, "gob").has(hunting)) {
        planned.length = 0;
        planned.push({ op: { t: "clock.advance", by: 600 }, who: DM }, { op: { t: "encounter.prev" }, who: DM });
        hunting = null;
      } else if (hunting !== null && planned.length === 0) hunting = null;
      // Invariant 5.
      const held = heldClock(state, P1)?.id;
      const seen = projectState(state, P1, { sceneId: "s1" });
      for (const c of Object.values(seen.characters)) for (const e of c.actor.effects) if (e.ends?.at !== undefined) assert.equal(e.ends.clock, held, `${where}: a player's end`);
      for (const t of Object.values(seen.tokens)) if ("inline" in t.actor) for (const e of t.actor.inline.effects) if (e.ends?.at !== undefined) assert.equal(e.ends.clock, held, `${where}: a player's end`);

      // The DM's stacks: a new step of the DM's clears its scope's redo, an undo's inverse is its redo and a redo's its undo.
      if (op.t === "sys.restore" && restoreOf) {
        counts.restores++;
        const stack = stacks[restoreOf.scope];
        if (applied.inverse) (restoreOf.from === "undo" ? stack.redo : stack.undo).push(applied.inverse);
      } else if (op.t === "sys.restore") {
        if (applied.inverse) stacks.play.redo.push(applied.inverse);
      } else if (who === DM && applied.inverse) {
        const stack = stacks[scopeOf(op)];
        stack.undo.push(applied.inverse);
        stack.redo.length = 0;
      }
      if (op.t === "clock.set" && planned.length === 1 && planned[0]!.who === CO_DM && chance(r, 0.8)) {
        planned.push({ op: { t: "sys.restore", entries: applied.inverse ?? [], from: "undo", deps: true, scope: "play", correction: { label: "a step" } } as Op, who: DM });
        stacks.play.undo.pop();
      }
    }
  }
  assert.ok(counts.ended > 800, `enough ends (${counts.ended})`);
  assert.ok(counts.restoreEnds > 200, `enough ends in a restore (${counts.restoreEnds})`);
  assert.ok(counts.prevAfterNext > 100, `enough Previous right after a Next (${counts.prevAfterNext})`);
  assert.ok(counts.restores > 600, `enough restores (${counts.restores})`);
  assert.ok(counts.filtered > 40, `enough spans Previous left out (${counts.filtered})`);
});
