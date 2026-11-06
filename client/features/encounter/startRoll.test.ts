import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { createStore } from "zustand/vanilla";
import { actor, apply, DM, room, token } from "#shared/testutil.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { RoomState } from "#shared/model.ts";
import type { OpAnswer } from "../../state/types.ts";
import { startStep, type StartFrom, type StartWait } from "./autoState.ts";

/*
 * Roll monsters' Initiative as the fight starts (designs/qol audit Q12,
 * plan 9): the start's ops go as one gesture, and once the server takes
 * every one the monsters roll. Its wait first as pure steps under random
 * answers, then the press through the hook as the tracker calls it.
 */

const ANSWERS: readonly OpAnswer[] = ["taken", "refused", "unknown"];

describe("the start's wait, at random", () => {
  type Event =
    | { kind: "press"; ops: number; from: StartFrom }
    | { kind: "answer"; press: number; index: number; answer: OpAnswer }
    // A duplicate or stale answer: one for an op already answered, a press that ended, or a place the start never had.
    | { kind: "stray"; press: number; index: number; answer: OpAnswer }
    // The connection drops: whatever is unanswered is let go of as unknown (state/store.ts prepareHello), some of it.
    | { kind: "drop"; keep: number }
    // The tracker closes and opens: the wait is the room's, so nothing about it changes.
    | { kind: "close" };
  const event: fc.Arbitrary<Event> = fc.oneof(
    { weight: 3, arbitrary: fc.record({ kind: fc.constant("press" as const), ops: fc.integer({ min: 0, max: 4 }), from: fc.constantFrom<StartFrom>("selected", "scene", "visible") }) },
    { weight: 6, arbitrary: fc.record({ kind: fc.constant("answer" as const), press: fc.nat(8), index: fc.nat(5), answer: fc.constantFrom(...ANSWERS, "taken", "taken") }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("stray" as const), press: fc.nat(8), index: fc.integer({ min: -1, max: 6 }), answer: fc.constantFrom(...ANSWERS) }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("drop" as const), keep: fc.nat(3) }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("close" as const) }) },
  );

  test("at most one roll a press, never after a refused or unsure op, a roll whenever every op is taken, and never busy once every op is answered", () => {
    fc.assert(
      fc.property(fc.array(event, { maxLength: 60 }), fc.array(fc.constantFrom(...ANSWERS), { minLength: 20, maxLength: 20 }), (events, finals) => {
        let wait: StartWait | null = null;
        // Read through a call: the steps below set it from inside a closure, which narrowing cannot see.
        const current = (): StartWait | null => wait;
        // What the controller sent for each press it let go, and what became of each op, first answer only, as onAnswer hears once.
        const presses: { id: string; ops: number; answers: (OpAnswer | null)[]; rolls: number; failedBefore: boolean }[] = [];
        let refusedPresses = 0;
        const step = (e: Parameters<typeof startStep>[1]) => {
          const before: StartWait | null = wait;
          const out = startStep(wait, e);
          wait = out.wait;
          if (out.roll) {
            const p = presses.find((x) => x.id === before?.press);
            assert.ok(p, "a roll belongs to the press that waited");
            p.rolls++;
            assert.ok(!p.failedBefore, "never a roll after a refused or unsure op");
            assert.ok(p.answers.every((a) => a === "taken"), "a roll only once every op is taken");
          }
        };
        const answer = (p: (typeof presses)[number], index: number, a: OpAnswer) => {
          if (p.answers[index] !== null) return;
          p.answers[index] = a;
          if (a !== "taken") p.failedBefore = true;
          step({ kind: "answer", press: p.id, index, answer: a });
        };
        for (const e of events) {
          if (e.kind === "press") {
            // The controller's own rule: nothing goes while a start waits.
            const held = current();
            if (held !== null) {
              refusedPresses++;
              step({ kind: "press", press: `x${refusedPresses}`, from: e.from, ops: e.ops });
              assert.equal(current(), held, "a second press never replaces the wait");
              continue;
            }
            const id = `p${presses.length}`;
            presses.push({ id, ops: e.ops, answers: Array.from({ length: e.ops }, () => null), rolls: 0, failedBefore: false });
            step({ kind: "press", press: id, from: e.from, ops: e.ops });
            assert.equal(current() === null, e.ops === 0, "a start with ops waits");
          } else if (e.kind === "answer") {
            const p = presses[e.press % Math.max(presses.length, 1)];
            if (p && p.ops > 0) answer(p, e.index % p.ops, e.answer);
          } else if (e.kind === "stray") {
            const p = presses[e.press % Math.max(presses.length, 1)];
            const before = current();
            if (!p) continue;
            const answered = e.index >= 0 && e.index < p.ops && p.answers[e.index] !== null;
            const outside = e.index < 0 || e.index >= p.ops;
            const ended = before === null || before.press !== p.id;
            if (!answered && !outside && !ended) continue;
            step({ kind: "answer", press: p.id, index: e.index, answer: e.answer });
            assert.equal(current(), before, "a stray answer changes nothing");
          } else if (e.kind === "drop") {
            for (const p of presses) p.answers.forEach((a, i) => (a === null && i >= e.keep ? answer(p, i, "unknown") : undefined));
          }
        }
        // Every op answered in the end, whatever came first.
        let k = 0;
        for (const p of presses) p.answers.forEach((a, i) => (a === null ? answer(p, i, finals[k++ % finals.length]!) : undefined));
        assert.equal(current(), null, "never busy once every op has its answer");
        for (const p of presses) {
          assert.ok(p.rolls <= 1, "at most one roll a press");
          const allTaken = p.ops > 0 && p.answers.every((a) => a === "taken");
          assert.equal(p.rolls, allTaken ? 1 : 0, `${p.id}: ${p.answers.join(",")}`);
        }
      }),
      { numRuns: 2000 },
    );
  });
});

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { useStartFight } = await import("./AutoInitiative.tsx");
const { useAutoStore, useRollBusy } = await import("./autoState.ts");

type Sent = { op: ClientOp; group?: string; onAnswer?: (answer: OpAnswer) => void };

/** A DM's room with two goblins and a PC, the hook as the tracker calls it, and the ops it sends. */
function table(opts: { switchOff?: boolean; scores?: boolean; connection?: string; unsent?: ClientOp["t"] } = {}) {
  const items = new Map<string, string>(opts.switchOff ? [["rvtt.autoInitiativeStart.r1", "off"]] : []);
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
  let view = room({
    tokens: {
      g1: token("g1", { actor: { inline: actor({ initBonus: 2, initScore: 12 }) } }),
      g2: token("g2", { actor: { inline: actor({ initBonus: 2, initScore: 12 }) } }),
      pc: token("pc", { kind: "pc", name: "Thorn" }),
    },
  });
  if (opts.scores) view = { ...view, meta: { ...view.meta, settings: { ...view.meta.settings, monsterInitScore: true } } };
  const scope = new RoomScope();
  const store = createStore(() => ({ view, roomId: "r1", connection: opts.connection ?? "open", you: DM, sceneId: "s1", local: { selectedIds: [], multi: false }, pending: [] }));
  const sent: Sent[] = [];
  let ids = 0;
  const actions = {
    newId: () => `id${++ids}`,
    dispatch: (op: ClientOp, o?: { group?: string; onAnswer?: (answer: OpAnswer) => void }) => {
      // A malformed op is never queued, so it has no answer to wait for.
      if (op.t === opts.unsent) return null;
      sent.push({ op, ...(o?.group ? { group: o.group } : {}), ...(o?.onAnswer ? { onAnswer: o.onAnswer } : {}) });
      return sent.length;
    },
  };
  let start: ReturnType<typeof useStartFight> | undefined;
  let auto: ReturnType<typeof useAutoStore> | undefined;
  function Probe() {
    start = useStartFight();
    auto = useAutoStore();
    return null;
  }
  /** Draws `child` in this room, as markup, which reads each store's first state: so the auto store's state now is made its first. */
  const draw = (child: () => unknown) => {
    if (auto) auto.getInitialState = auto.getState;
    renderToStaticMarkup(createElement(RoomProvider, {
      store: store as never, actions: actions as never, ui: { notify() {} } as never, assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope, children: createElement(() => (child(), null)) }),
    }));
  };
  draw(Probe);
  /** The server takes the start's ops: the view now holds what they did. */
  const land = () => {
    let next: RoomState = store.getState().view;
    for (const s of sent) if (s.op.t === "encounter.start" || s.op.t === "encounter.add") next = apply(next, s.op);
    store.setState({ view: next });
  };
  const done = () => delete (globalThis as { localStorage?: unknown }).localStorage;
  /** Whether every roll button waits now (useRollBusy). */
  const busy = () => {
    let out = false;
    draw(() => (out = useRollBusy()));
    return out;
  };
  return { start: start!, auto: auto!, sent, store, land, done, busy };
}

const BATCHES = [[{ id: "e1", tokenId: "g1" }, { id: "e2", tokenId: "pc" }], [{ id: "e3", tokenId: "g2" }]];

describe("starting a fight (Q12)", () => {
  test("the start and every add batch go as one gesture, and once all are taken the monsters roll, behind the screen", () => {
    const t = table();
    try {
      assert.equal(t.start(BATCHES, "scene"), true);
      assert.deepEqual(t.sent.map((s) => s.op.t), ["encounter.start", "encounter.add"]);
      assert.ok(t.sent[0]!.group && t.sent.every((s) => s.group === t.sent[0]!.group), "one group: one Play step");
      assert.equal(t.auto.getState().start?.from, "scene", "the pressed button waits");
      assert.equal(t.busy(), true, "and every roll button with it");
      assert.equal(t.start(BATCHES, "visible"), false, "a second press while it waits sends nothing");
      assert.equal(t.sent.length, 2);
      t.land();
      t.sent[1]!.onAnswer!("taken");
      assert.equal(t.sent.length, 2, "no roll until every op is taken");
      t.sent[0]!.onAnswer!("taken");
      const roll = t.sent[2]?.op;
      assert.ok(roll?.t === "dice.roll", JSON.stringify(t.sent.map((s) => s.op.t)));
      assert.equal(roll.to, "dm", "monsters' dice stay the DM's");
      assert.equal(roll.rolls.length, 1, "identical goblins share one roll, by creature, the tracker's default");
      assert.equal(roll.rolls[0]!.initiative, true);
      assert.equal(t.auto.getState().start, null);
      assert.ok(t.auto.getState().last?.tag, "the result card follows the roll as after Auto Initiative's own press");
    } finally {
      t.done();
    }
  });

  test("any answer but taken ends the wait with no roll", () => {
    for (const answer of ["refused", "unknown"] as const) {
      const t = table();
      try {
        t.start(BATCHES, "scene");
        t.sent[0]!.onAnswer!(answer);
        t.land();
        t.sent[1]!.onAnswer!("taken");
        assert.deepEqual(t.sent.map((s) => s.op.t), ["encounter.start", "encounter.add"]);
        assert.equal(t.auto.getState().start, null);
        assert.equal(t.busy(), false, "no button left busy");
      } finally {
        t.done();
      }
    }
  });

  test("off, Nobody yet, or every monster valued by its score: the start goes as one gesture and nothing rolls", () => {
    const off = table({ switchOff: true });
    try {
      off.start(BATCHES, "scene");
      assert.ok(off.sent.every((s) => s.onAnswer === undefined && s.group === off.sent[0]!.group));
      assert.equal(off.auto.getState().start, null);
    } finally {
      off.done();
    }
    const nobody = table();
    try {
      nobody.start([], null);
      assert.deepEqual(nobody.sent.map((s) => [s.op.t, s.onAnswer]), [["encounter.start", undefined]]);
    } finally {
      nobody.done();
    }
    const scores = table({ scores: true });
    try {
      scores.start(BATCHES, "scene");
      scores.land();
      for (const s of scores.sent) s.onAnswer!("taken");
      assert.deepEqual(scores.sent.map((s) => s.op.t), ["encounter.start", "encounter.add"], "rows that start with their score have nothing to roll");
      assert.equal(scores.auto.getState().start, null);
      assert.equal(scores.auto.getState().last, null, "and no card, since nothing was pressed");
    } finally {
      scores.done();
    }
  });

  test("an op that could not be sent ends the wait as a refusal does", () => {
    const t = table({ unsent: "encounter.add" });
    try {
      t.start(BATCHES, "scene");
      t.land();
      t.sent[0]!.onAnswer!("taken");
      assert.deepEqual(t.sent.map((s) => s.op.t), ["encounter.start"]);
      assert.equal(t.auto.getState().start, null);
      assert.equal(t.busy(), false);
    } finally {
      t.done();
    }
  });

  test("a connection lost after the rows land leaves the fight started, and the card says rolling needs one", () => {
    const t = table();
    try {
      t.start(BATCHES, "selected");
      t.land();
      t.store.setState({ connection: "closed" });
      for (const s of t.sent) s.onAnswer!("taken");
      assert.equal(t.sent.length, 2);
      assert.equal(t.auto.getState().last?.error, "Rolling needs a connection.");
    } finally {
      t.done();
    }
  });
});
