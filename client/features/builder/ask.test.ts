import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { serializedBytes } from "#shared/limits.ts";
import { ASK_LOST, clientOpSchema, FORGET_ASK, MAX_ASK_BYTES, MAX_ASK_OPS, MAX_ASK_PARTS, MAX_BUILD_CELLS, type ClientOp } from "#shared/protocol.ts";
import type { OnAnswer, OpRefusal } from "../../state/types.ts";
import { askOps, BUILD_NOT_MADE, dispatchBuild, type BuildContext } from "./ask.ts";
import { rectOps } from "./cells.ts";

/*
 * A builder gesture of several ops asks before any applies
 * (docs/design-v1-map-discovery.md 5.3), and its ops stay on the device
 * until the answer (MD4-ASTRA-5), so the forget question comes before the
 * first band and a no leaves nothing built.
 */

const explore = { id: "s1", fogEnabled: true, vision: { on: true, light: "dark" as const } };
const bands = rectOps("s1", { x: 0, y: 0, w: 80, h: 64 }, "stone", { w: 80, h: 64 });

type Sent = { n: number; op: ClientOp; group?: string; holds?: readonly ClientOp[]; onAnswer?: OnAnswer };

/** A device's actions that record what goes out, a toast list, and the builder's count of gestures waiting on their asks. */
function device(scene = explore) {
  const sent: Sent[] = [];
  const toasts: string[] = [];
  const waits: number[] = [];
  let ids = 0;
  let waiting = 0;
  const ctx: BuildContext = {
    actions: {
      dispatch: (op, opts) => {
        sent.push({ n: sent.length + 1, op, ...(opts?.group !== undefined ? { group: opts.group } : {}), ...(opts?.holds ? { holds: opts.holds } : {}), ...(opts?.onAnswer ? { onAnswer: opts.onAnswer } : {}) });
        return sent.length;
      },
      newId: () => `g${++ids}`,
    },
    ui: { notify: (text) => void toasts.push(text) },
    scene,
    waiting: (change) => void waits.push((waiting += change)),
  };
  /** Answers every ask sent so far that has no answer yet. */
  const answerAsks = (answer: Parameters<OnAnswer>[0], refusal?: (ask: Sent) => OpRefusal | undefined) => {
    for (const s of sent.filter((s) => s.op.t === "build.ask" && s.onAnswer)) {
      const told = s.onAnswer!;
      delete s.onAnswer;
      told(answer, refusal?.(s));
    }
  };
  return { sent, toasts, waits, ctx, answerAsks, kinds: () => sent.map((s) => s.op.t) };
}

const lost: OpRefusal = { code: "invalid", message: ASK_LOST, text: "Not saved." };
const forget = (): OpRefusal => ({ code: "forget", message: FORGET_ASK, text: FORGET_ASK });

describe("a builder gesture asks before it applies, and holds its ops until the answer", () => {
  test("a big rectangle sends its asks alone, and its bands only once every ask is answered as fitting, under one group", () => {
    assert.ok(bands.length > 1, "the rectangle goes as bands");
    const d = device();
    dispatchBuild(d.ctx, bands);
    assert.deepEqual(d.kinds(), ["build.ask"], "no band before the answer");
    const { onAnswer: _told, ...ask } = d.sent[0]!;
    assert.deepEqual(ask, { n: 1, op: { t: "build.ask", sceneId: "s1", ops: bands, part: 0 }, group: "g1", holds: bands });
    assert.deepEqual(d.waits, [1], "the builder says it is checking");
    d.answerAsks("taken");
    assert.deepEqual(d.sent.slice(1).map((s) => [s.op, s.group]), bands.map((op) => [op, "g1"]));
    assert.deepEqual(d.waits, [1, 0]);
  });

  test("asks refused with forget send nothing: the store asks the question about the ops the last ask holds", () => {
    const d = device();
    dispatchBuild(d.ctx, bands);
    d.answerAsks("refused", forget);
    assert.deepEqual(d.kinds(), ["build.ask"]);
    assert.deepEqual(d.toasts, []);
    assert.deepEqual(d.waits, [1, 0]);
  });

  test("asks the server lost go again from the start once, under a group of their own: after a restart past an answered part, and after an answer lost with the connection", () => {
    // A gesture of two asks: the first answered, then the server restarts and refuses the second as lost.
    const many = Array.from({ length: MAX_ASK_OPS + 1 }, (_, k): ClientOp => ({ t: "build.paint", sceneId: "s1", terrain: "stone", cells: [`${k},0`] }));
    const d = device();
    dispatchBuild(d.ctx, many);
    const asked = (from: number) => d.sent.slice(from).map((s) => [s.op.t, (s.op as { part?: number }).part, s.group]);
    assert.deepEqual(asked(0), [["build.ask", 0, "g1"], ["build.ask", 1, "g1"]]);
    d.sent[0]!.onAnswer!("taken");
    d.sent[1]!.onAnswer!("refused", lost);
    assert.deepEqual(asked(2), [["build.ask", 0, "g2"], ["build.ask", 1, "g2"]], "asked again whole, no paint sent");
    d.sent[2]!.onAnswer!("taken");
    d.sent[3]!.onAnswer!("taken");
    assert.deepEqual(d.sent.slice(4).map((s) => [s.op.t, s.group]), many.map(() => ["build.paint", "g2"]));
    assert.deepEqual(d.waits, [1, 0], "one wait for the whole");
    // The last ask's answer, a refusal with forget, lost to a dropped connection: the snapshot settles it unknown.
    const k = device();
    dispatchBuild(k.ctx, bands);
    k.answerAsks("unknown");
    assert.deepEqual(k.kinds(), ["build.ask", "build.ask"], "asked again, no band sent");
    k.answerAsks("refused", forget);
    assert.deepEqual(k.kinds(), ["build.ask", "build.ask"]);
    assert.deepEqual(k.toasts, []);
  });

  test("a second loss sends nothing and says the change was not made, and a refusal for another reason says its own words", () => {
    const d = device();
    dispatchBuild(d.ctx, bands);
    d.answerAsks("refused", () => lost);
    d.answerAsks("unknown");
    assert.deepEqual(d.kinds(), ["build.ask", "build.ask"]);
    assert.deepEqual(d.toasts, [BUILD_NOT_MADE]);
    assert.deepEqual(d.waits, [1, 0]);
    const k = device();
    dispatchBuild(k.ctx, bands);
    k.answerAsks("refused", () => ({ code: "forbidden", message: "only the DM builds", text: "Only the DM builds." }));
    assert.deepEqual(k.kinds(), ["build.ask"]);
    assert.deepEqual(k.toasts, ["Only the DM builds."]);
    assert.deepEqual(k.waits, [1, 0]);
  });

  test("a gesture of one op, and any gesture on a scene that keeps no memory, sends its ops at once with no ask", () => {
    const one = rectOps("s1", { x: 0, y: 0, w: 4, h: 4 }, "stone", { w: 80, h: 64 });
    const d = device();
    dispatchBuild(d.ctx, one);
    assert.deepEqual(d.kinds(), ["build.rect"]);
    assert.deepEqual(d.waits, []);
    for (const scene of [{ ...explore, fogEnabled: false }, { ...explore, vision: { on: false, light: "dark" as const } }]) {
      const k = device(scene);
      dispatchBuild(k.ctx, bands);
      assert.ok(k.sent.every((s) => s.op.t === "build.rect"), JSON.stringify(scene));
    }
  });

  test("asks carry the gesture's own builder ops on the scene, without a yes, split past an ask's ops or bytes, numbered, all but the last saying more", () => {
    const paint = (k: number): ClientOp => ({ t: "build.paint", sceneId: "s1", terrain: "stone", cells: Array.from({ length: MAX_BUILD_CELLS }, (_, i) => `${i % 100},${k * 20 + Math.floor(i / 100)}`), forget: true });
    const ops = [paint(0), paint(1), paint(2), paint(3), { t: "build.label", sceneId: "s1", labelId: "l1", label: null } as ClientOp];
    const asks = askOps("s1", ops);
    assert.ok(asks.length > 1, "four full paints pass one ask's bytes");
    assert.deepEqual(asks.flatMap((a) => a.ops).map((o) => ("cells" in o ? o.cells[0] : null)), [0, 1, 2, 3].map((k) => `0,${k * 20}`), "every paint, in order, and no label");
    assert.ok(asks.flatMap((a) => a.ops).every((o) => !("forget" in o)));
    assert.deepEqual(asks.map((a) => a.more === true), [...asks.slice(1).map(() => true), false]);
    assert.deepEqual(asks.map((a) => a.part), asks.map((_, i) => i));
    assert.ok(asks.every((a) => serializedBytes(a) <= MAX_ASK_BYTES && a.ops.length <= MAX_ASK_OPS));
    assert.ok(asks.every((a) => clientOpSchema.safeParse(a).success), "each ask is an op the server takes");
    assert.equal(clientOpSchema.safeParse({ t: "build.ask", sceneId: "s1", ops: [ops[4]], part: 0 }).success, false, "an ask carries builder ops only");
    const many = Array.from({ length: MAX_ASK_OPS + 1 }, (_, k): ClientOp => ({ t: "build.paint", sceneId: "s1", terrain: "stone", cells: [`${k},0`] }));
    assert.deepEqual(askOps("s1", many).map((a) => a.ops.length), [MAX_ASK_OPS, 1]);
    assert.deepEqual(askOps("s2", many), [], "ops on another scene are not this ask's");
    // Past the parts one gesture may ask in, it asks none, and goes as a stroke does.
    const most = Array.from({ length: MAX_ASK_OPS * MAX_ASK_PARTS + 1 }, (_, k): ClientOp => ({ t: "build.paint", sceneId: "s1", terrain: "stone", cells: [`${k % 200},${Math.floor(k / 200)}`] }));
    assert.deepEqual(askOps("s1", most), []);
    assert.equal(askOps("s1", most.slice(1)).length, MAX_ASK_PARTS);
    const d = device();
    dispatchBuild(d.ctx, most);
    assert.ok(d.sent.every((s) => s.op.t === "build.paint"));
  });
});
