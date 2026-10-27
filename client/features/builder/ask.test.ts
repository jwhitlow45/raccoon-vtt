import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { serializedBytes } from "#shared/limits.ts";
import { ASK_LOST, clientOpSchema, FORGET_ASK, MAX_ASK_BYTES, MAX_ASK_OPS, MAX_ASK_PARTS, MAX_BUILD_CELLS, type ClientOp } from "#shared/protocol.ts";
import { DM, room as testRoom } from "#shared/testutil.ts";
import type { ServerMessage } from "#shared/protocol.ts";
import { LocalServer } from "../../dev/localServer.ts";
import { createRoomActions } from "../../state/actions.ts";
import { RoomScope } from "../../state/scope.ts";
import { createRoomStore, MAX_OP_AGE_MS } from "../../state/store.ts";
import { FakeClock, FakeOutbox } from "../../state/testing.ts";
import type { OnAnswer, OpRefusal, UnknownCause } from "../../state/types.ts";
import type { ToolContext, ToolPointer } from "../tools.ts";
import { askOps, BUILD_NOT_MADE, dispatchBuild, whileAsking, type BuildContext } from "./ask.ts";
import { rectOps } from "./cells.ts";
import { builderSlot } from "./store.ts";

/*
 * A builder gesture of several ops asks before any applies
 * (docs/design-v1-map-discovery.md 5.3), and its ops stay on the device
 * until the answer (MD4-ASTRA-5), so the forget question comes before the
 * first band and a no leaves nothing built.
 */

const explore = { id: "s1", fogEnabled: true, vision: { on: true, light: "dark" as const } };
const bands = rectOps("s1", { x: 0, y: 0, w: 80, h: 64 }, "stone", { w: 80, h: 64 });

type Sent = { n: number; op: ClientOp; group?: string; holds?: () => readonly ClientOp[]; onAnswer?: OnAnswer };

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
  /** Answers every ask sent so far that has no answer yet, `unknown` with how it came about. */
  const answerAsks = (answer: Parameters<OnAnswer>[0], refusal?: (ask: Sent) => OpRefusal | undefined, unknown?: UnknownCause) => {
    for (const s of sent.filter((s) => s.op.t === "build.ask" && s.onAnswer)) {
      const told = s.onAnswer!;
      delete s.onAnswer;
      told(answer, refusal?.(s), unknown);
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
    const { onAnswer: _told, holds, ...ask } = d.sent[0]!;
    assert.deepEqual(ask, { n: 1, op: { t: "build.ask", sceneId: "s1", ops: bands, part: 0 }, group: "g1" });
    assert.deepEqual(holds?.(), bands, "the ask holds the bands");
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
    k.answerAsks("unknown", undefined, "snapshot");
    assert.deepEqual(k.kinds(), ["build.ask", "build.ask"], "asked again, no band sent");
    k.answerAsks("refused", forget);
    assert.deepEqual(k.kinds(), ["build.ask", "build.ask"]);
    assert.deepEqual(k.toasts, []);
  });

  test("a second loss sends nothing and says the change was not made, and a refusal for another reason says its own words", () => {
    const d = device();
    dispatchBuild(d.ctx, bands);
    d.answerAsks("refused", () => lost);
    d.answerAsks("unknown", undefined, "snapshot");
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

  test("asks too old to send end the gesture with nothing sent and no word of their own, and only a lost connection or ASK_LOST asks again", () => {
    const d = device();
    dispatchBuild(d.ctx, bands);
    d.answerAsks("unknown", undefined, "expired");
    assert.deepEqual(d.kinds(), ["build.ask"]);
    assert.deepEqual(d.toasts, [], "the store's toast counts it");
    assert.deepEqual(d.waits, [1, 0]);
    const k = device();
    dispatchBuild(k.ctx, bands);
    k.answerAsks("unknown");
    assert.deepEqual(k.kinds(), ["build.ask"], "an unknown that says nothing of how is not asked again");
    assert.deepEqual(k.toasts, [BUILD_NOT_MADE]);
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

/** A DM's page on an Explore scene: its store, the room's actions, the builder's count of waiting gestures, and a server the page reaches through `deliver`. */
function page() {
  const state = testRoom();
  state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true, vision: { on: true, light: "bright" }, bounds: { w: 80, h: 64 } };
  const clock = new FakeClock();
  const outbox = new FakeOutbox();
  const server = new LocalServer(structuredClone(state), DM, "s1");
  const room = createRoomStore({ roomId: "R1", you: DM, clock, random: () => 0.5, clientId: "c1" });
  room.setOutbox(outbox);
  const actions = createRoomActions(room, { sendEph: () => undefined, switchScene: () => undefined });
  const counted = { waiting: 0 };
  const ctx: BuildContext = { actions, ui: room.ui, scene: state.scenes.s1!, waiting: (change) => void (counted.waiting += change), asking: () => counted.waiting > 0 };
  const connect = () => {
    const hello = room.prepareHello();
    room.applySnapshot(server.hello({ resumeFrom: hello.resumeFrom, sceneId: "s1" }));
  };
  /** Every op the page sent goes to the server, and its answers come back, until the page sends nothing more. */
  const deliver = () => {
    for (let round = 0; round < 10; round++) {
      const ops = outbox.sent.flatMap((m) => (m.t === "op" ? [{ n: m.n, op: m.op }] : []));
      outbox.sent = [];
      if (ops.length === 0) return;
      for (const msg of server.batch(ops) as ServerMessage[]) {
        if (msg.t === "ev") room.applyEv(msg);
        else if (msg.t === "snapshot") room.applySnapshot(msg);
      }
    }
  };
  /** Ops the page sent so far, by kind. */
  const sentKinds = () => outbox.sent.flatMap((m) => (m.t === "op" ? [(m.op as ClientOp).t] : []));
  const cell = (key: string) => server.state.buildChunks["s1:0,0"]?.cells[key];
  return { clock, outbox, server, room, actions, ctx, counted, connect, deliver, sentKinds, cell };
}

describe("no builder edit overtakes a gesture waiting on its asks (MD4-ASTRA-9, D-261027-07)", () => {
  // A rectangle of stone in two bands over (1, 1), and a paint of wood there after it.
  const rect = rectOps("s1", { x: 0, y: 0, w: 80, h: 40 }, "stone", { w: 80, h: 64 });
  const paint: ClientOp = { t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["1,1"] };

  test("offline, a paint after a waiting rectangle is refused at input, and back online the rectangle is built and nothing came before it", () => {
    const p = page();
    p.connect();
    p.room.suspend();
    p.outbox.open = false;
    assert.equal(rect.length, 2);
    dispatchBuild(p.ctx, rect);
    assert.equal(p.actions.dispatch(paint), null, "the paint is refused while the rectangle waits");
    assert.equal(p.counted.waiting, 1);
    p.outbox.open = true;
    p.connect();
    p.deliver();
    assert.equal(p.cell("1,1"), "stone");
    assert.equal(p.counted.waiting, 0);
    // Once it is answered, the builder takes edits again.
    assert.notEqual(p.actions.dispatch(paint), null);
    p.deliver();
    assert.equal(p.cell("1,1"), "wood");
  });

  test("Undo while the gesture waits cancels it: nothing of it is sent, its answers are let go, and no undo goes", () => {
    const p = page();
    p.connect();
    dispatchBuild(p.ctx, rect);
    p.actions.undo();
    assert.equal(p.counted.waiting, 0, "the line clears");
    assert.deepEqual(p.sentKinds(), ["build.ask"], "no undo was sent");
    p.deliver();
    assert.equal(p.cell("1,1"), undefined, "no band went");
    assert.equal(p.room.store.getState().forgetAsk ?? null, null);
    // The next Undo is the room's again.
    p.actions.undo();
    assert.deepEqual(p.sentKinds(), ["undo"]);
    // A cancelled gesture's ask refused with forget asks nothing: it holds no ops any more.
    const k = page();
    k.connect();
    dispatchBuild(k.ctx, rect);
    k.actions.undo();
    const asked = k.outbox.sent.find((m) => m.t === "op")!;
    assert.ok(asked.t === "op" && (asked.op as ClientOp).t === "build.ask");
    k.room.applyEv({ t: "ev", seq: k.room.store.getState().seq + 1, changes: [], rejects: [{ n: asked.n, code: "forget", message: FORGET_ASK }] });
    assert.equal(k.room.store.getState().forgetAsk ?? null, null, "a question about a cancelled gesture");
  });

  test("a second gesture while one waits sends nothing, and the first is built whole once answered", () => {
    const p = page();
    p.connect();
    dispatchBuild(p.ctx, rect);
    dispatchBuild(p.ctx, rectOps("s1", { x: 0, y: 0, w: 80, h: 40 }, "wood", { w: 80, h: 64 }));
    assert.deepEqual(p.sentKinds(), ["build.ask"], "the second gesture asked nothing");
    p.deliver();
    assert.equal(p.cell("1,1"), "stone");
    assert.equal(p.counted.waiting, 0);
  });

  test("Redo while the gesture waits sends nothing, so no step it would bring back lands before the gesture", () => {
    const p = page();
    p.connect();
    dispatchBuild(p.ctx, rect);
    p.actions.redo();
    assert.deepEqual(p.sentKinds(), ["build.ask"], "no redo was sent");
    p.deliver();
    assert.equal(p.counted.waiting, 0);
    p.actions.redo();
    assert.equal(p.sentKinds().at(-1), "redo", "once the gesture is answered, Redo is the room's again");
  });

  test("the forget toast's Forget and undo and Forget and redo do nothing while the gesture waits, and the toast stays for a press once it is answered (MD4-ASTRA-13)", () => {
    for (const t of ["undo", "redo"] as const) {
      // An Undo or Redo the server asked about leaves its toast up, then a rectangle waits on its asks.
      const p = page();
      p.connect();
      const n = p.room.dispatch({ t })!;
      p.room.applyEv({ t: "ev", seq: p.room.store.getState().seq + 1, changes: [], rejects: [{ n, code: "forget", message: FORGET_ASK }] });
      const toast = () => p.room.store.getState().toasts.find((x) => x.action !== undefined);
      assert.equal(toast()?.action?.label, t === "undo" ? "Forget and undo" : "Forget and redo");
      // The server hears the step too, so its numbers stay in step with the page's.
      p.deliver();
      dispatchBuild(p.ctx, rect);
      // The toast's button is not ready, so a press does nothing and the toast stays (Room.tsx), and its step would be refused anyway.
      assert.equal(toast()!.action!.ready?.(), false, `${t}: the button waits`);
      toast()!.action!.run();
      assert.deepEqual(p.sentKinds(), ["build.ask"], `${t}: nothing went before the bands`);
      p.deliver();
      assert.equal(p.cell("1,1"), "stone", `${t}: the rectangle went`);
      assert.notEqual(toast()!.action!.ready?.(), false, `${t}: once the rectangle is answered, the button is ready`);
      toast()!.action!.run();
      assert.deepEqual(p.sentKinds(), [t]);
    }
  });

  test("while a gesture waits, a step off the top of the stack from any sender is refused, and an undo aimed at one op goes", () => {
    const p = page();
    p.connect();
    dispatchBuild(p.ctx, rect);
    for (const op of [{ t: "undo" }, { t: "undo", forget: 3 }, { t: "redo" }, { t: "redo", forget: 3 }] as ClientOp[]) assert.equal(p.room.dispatch(op), null, JSON.stringify(op));
    assert.notEqual(p.room.dispatch({ t: "undo", of: 1 }), null, "the token bar's Undo move and a stroke's quiet undo are aimed at one op");
    assert.notEqual(p.room.dispatch({ t: "undo", log: "1:1" }), null, "an HP change taken back from its log line");
    assert.deepEqual(p.sentKinds(), ["build.ask", "undo", "undo"]);
  });

  test("a press on the builder's map while a gesture waits starts nothing, and its move and lift do nothing", () => {
    const scope = new RoomScope();
    const calls: string[] = [];
    const handlers = whileAsking({ down: () => void calls.push("down"), move: () => void calls.push("move"), up: () => void calls.push("up") });
    const ctx = { scope } as unknown as ToolContext;
    const at = {} as ToolPointer;
    scope.get(builderSlot).store.setState({ asking: 1 });
    handlers.down!(at, ctx);
    handlers.move!(at, ctx);
    scope.get(builderSlot).store.setState({ asking: 0 });
    handlers.up!(at, ctx);
    assert.deepEqual(calls, [], "the press made while waiting stays refused to its lift");
    handlers.down!(at, ctx);
    handlers.up!(at, ctx);
    assert.deepEqual(calls, ["down", "up"]);
  });
});

describe("an expired gesture stays expired (MD4-ASTRA-11)", () => {
  test("a rectangle queued offline past MAX_OP_AGE_MS sends nothing after the reconnect, and the toast counts it as one edit", () => {
    const p = page();
    p.connect();
    p.room.suspend();
    p.outbox.open = false;
    dispatchBuild(p.ctx, rectOps("s1", { x: 0, y: 0, w: 80, h: 64 }, "stone", { w: 80, h: 64 }));
    p.clock.t += MAX_OP_AGE_MS + 1;
    p.room.dispatch({ t: "scene.update", sceneId: "s1", patch: { name: "Renamed" } });
    p.outbox.open = true;
    p.connect();
    p.deliver();
    assert.equal(p.cell("1,1"), undefined, "nothing of the rectangle applied");
    assert.equal(p.server.state.scenes.s1?.name, "Renamed");
    assert.equal(p.counted.waiting, 0);
    assert.deepEqual(p.room.store.getState().toasts.map((t) => t.text), ["1 offline edit was too old to save."]);
    // A gesture asked about in two parts is one edit too.
    const k = page();
    k.connect();
    k.room.suspend();
    k.outbox.open = false;
    const paints = Array.from({ length: MAX_ASK_OPS + 1 }, (_, i): ClientOp => ({ t: "build.paint", sceneId: "s1", terrain: "wood", cells: [`${i},1`] }));
    assert.equal(askOps("s1", paints).length, 2);
    dispatchBuild(k.ctx, paints);
    k.clock.t += MAX_OP_AGE_MS + 1;
    k.outbox.open = true;
    k.connect();
    k.deliver();
    assert.equal(k.cell("1,1"), undefined);
    assert.deepEqual(k.room.store.getState().toasts.map((t) => t.text), ["1 offline edit was too old to save."]);
  });
});
