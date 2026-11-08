import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { holds } from "#shared/propertyTestutil.ts";
import { drawable, flowStep, readiness, startFlow, type Flow, type FlowEvent } from "./flow.ts";

/** A worker's answer as the dialog holds it: the dungeon and the drawing its picture is made from. */
type Shown = { n: number; drawn: { n: number } };
const dungeon = (n: number): Shown => ({ n, drawn: { n } });

function run(events: FlowEvent<Shown>[], from: Flow<Shown> = startFlow<Shown>()): Flow<Shown> {
  return events.reduce(flowStep<Shown>, from);
}

const answered = (id: number, value: Shown): FlowEvent<Shown> => ({ k: "answer", id, answer: { ok: true, value } });

test("DG-R1-01: Make waits for the answer's own picture, and a newer answer mid-drawing keeps it off until that one's picture shows", () => {
  const a = dungeon(1);
  const b = dungeon(2);
  let f = run([{ k: "ask", id: 1 }, answered(1, a)]);
  assert.deepEqual(readiness(f), { current: null, drawing: true, pictureFailed: false }, "answered but not drawn: Make off, still drawing");
  f = flowStep(f, { k: "pictured", drawn: a.drawn });
  assert.deepEqual(readiness(f), { current: a, drawing: false, pictureFailed: false });

  // B is asked and answered while A's picture stands: Make stays off for B until B's picture is in.
  f = flowStep(f, { k: "ask", id: 2 });
  assert.equal(readiness(f).current, null, "off while B is asked");
  f = flowStep(f, answered(2, b));
  assert.deepEqual(readiness(f), { current: null, drawing: true, pictureFailed: false }, "A's picture shows for B's answer: Make off, still drawing");
  // A picture of A landing late stands for nothing Make sends.
  f = flowStep(f, { k: "pictured", drawn: a.drawn });
  assert.equal(readiness(f).current, null);
  f = flowStep(f, { k: "pictured", drawn: b.drawn });
  assert.deepEqual(readiness(f), { current: b, drawing: false, pictureFailed: false });
});

test("DG-R1-01: a picture that fails keeps Make off and says so, and the next answer's picture brings it back", () => {
  const a = dungeon(1);
  const b = dungeon(2);
  const c = dungeon(3);
  let f = run([{ k: "ask", id: 1 }, answered(1, a), { k: "pictured", drawn: a.drawn }, { k: "ask", id: 2 }, answered(2, b)]);
  f = flowStep(f, { k: "pictureFailed", drawn: b.drawn });
  assert.deepEqual(readiness(f), { current: null, drawing: false, pictureFailed: true });
  f = run([{ k: "ask", id: 3 }], f);
  assert.deepEqual(readiness(f), { current: null, drawing: true, pictureFailed: false }, "a new request says it draws, not that it failed");
  f = run([answered(3, c), { k: "pictured", drawn: c.drawn }], f);
  assert.deepEqual(readiness(f), { current: c, drawing: false, pictureFailed: false });
});

test("DGBUILD-ASTRA-2: a seed made invalid while a request draws drops its answer, and the preview kept stays", () => {
  const a = dungeon(1);
  let f = run([{ k: "ask", id: 1 }, answered(1, a), { k: "pictured", drawn: a.drawn }, { k: "ask", id: 2 }, { k: "invalid", id: 3 }]);
  assert.deepEqual(readiness(f), { current: null, drawing: false, pictureFailed: false }, "a bad seed: Make off, nothing drawing");
  const kept = f;
  f = run([answered(2, dungeon(2)), { k: "answer", id: 2, answer: { ok: false, error: "bug" } }], f);
  assert.equal(f, kept, "neither B's late answer nor a late failure moves anything");
  assert.equal(f.shown, a);
});

test("DGBUILD-ASTRA-2-RESIDUAL: a seed made invalid between the worker's answer and its encode cancels the render, and the kept picture stands", () => {
  const a = dungeon(1);
  const b = dungeon(2);
  let f = run([{ k: "ask", id: 1 }, answered(1, a), { k: "pictured", drawn: a.drawn }, { k: "ask", id: 2 }, answered(2, b)]);
  assert.equal(drawable(f), b.drawn, "B is answered and its picture is being made");
  f = flowStep(f, { k: "invalid", id: 3 });
  assert.equal(drawable(f), null, "nothing is asked to render once the seed is invalid");
  assert.equal(f.pictured, a.drawn, "A's picture is still the one shown");
  assert.equal(readiness(f).current, null);
  // The seed reads again: a request is out, and B's answer is again the newest shown.
  assert.equal(drawable(flowStep(f, { k: "ask", id: 4 })), b.drawn);
});

/** One thing that can happen to the dialog's preview, with ids and answers picked from what came before. */
type Act = { k: "ask" } | { k: "invalid" } | { k: "answer"; back: number; ok: boolean } | { k: "pictured"; back: number } | { k: "pictureFailed"; back: number };
const act: fc.Arbitrary<Act> = fc.oneof(
  fc.constant({ k: "ask" as const }),
  fc.constant({ k: "invalid" as const }),
  fc.record({ k: fc.constant("answer" as const), back: fc.nat(3), ok: fc.boolean() }),
  fc.record({ k: fc.constant("pictured" as const), back: fc.nat(3) }),
  fc.record({ k: fc.constant("pictureFailed" as const), back: fc.nat(1) }),
);

test("DG-R1-01, DGBUILD-ASTRA-2: across random requests, late answers, bad seeds and pictures, Make holds exactly the newest answer on screen", () => {
  holds(
    fc.property(fc.array(act, { maxLength: 60 }), (acts) => {
      let f = startFlow<Shown>();
      let n = 0;
      let newest = 0;
      let seedOk = true;
      const answers = new Map<number, Shown | "error">();
      /** The drawing the box shows, as Preview.tsx keeps it: the last picture made, gone on a failure. */
      let onScreen: object | null = null;
      /** The newest answer's picture failed and nothing newer was asked. */
      let failedNewest = false;
      for (const a of acts) {
        const before = f;
        if (a.k === "ask" || a.k === "invalid") {
          newest = ++n;
          seedOk = a.k === "ask";
          failedNewest = false;
          f = flowStep(f, { k: a.k, id: newest });
        } else if (a.k === "answer") {
          const id = Math.max(1, n - a.back);
          if (n === 0 || answers.has(id)) continue;
          const value = dungeon(id);
          answers.set(id, a.ok ? value : "error");
          f = flowStep(f, a.ok ? answered(id, value) : { k: "answer", id, answer: { ok: false, error: "fit" } });
          if (id !== newest) assert.equal(f, before, "an answer to an older request changes nothing");
          if (id !== newest || !seedOk) continue;
        } else {
          const ok = [...answers.values()].filter((x): x is Shown => x !== "error");
          const pick = ok[ok.length - 1 - a.back];
          if (!pick) continue;
          f = flowStep(f, { k: a.k, drawn: pick.drawn });
          onScreen = a.k === "pictured" ? pick.drawn : null;
          if (a.k === "pictureFailed" && pick.n === newest) failedNewest = true;
        }
        const r = readiness(f);
        const mine = answers.get(newest);
        if (r.current !== null) {
          assert.ok(seedOk, "Make is off for a bad seed");
          assert.equal(r.current, mine, "Make holds the newest request's answer");
          assert.equal(onScreen, r.current.drawn, "and its picture is the one on screen");
        }
        if (!seedOk) assert.equal(r.drawing, false, "nothing draws for a bad seed");
        if (seedOk && mine === undefined && newest > 0) assert.equal(r.drawing, true, "an unanswered request draws");
        if (seedOk && mine && mine !== "error") {
          if (onScreen === mine.drawn) assert.equal(r.current, mine, "its picture in, Make is on");
          else if (!failedNewest) assert.equal(r.drawing, true, "the indicator stays until its picture lands");
          else assert.equal(r.pictureFailed, true, "a failed picture says so");
        }
      }
    }),
    500,
  );
});
