import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { RoomState } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { holds } from "#shared/propertyTestutil.ts";
import type { OnAnswer, OpAnswer, RoomActions, RoomView } from "../../state/types.ts";
import { dialogScene, twoRooms } from "./handPlans.ts";
import { withIds } from "./ops.ts";
import { landAll, previewOf, scratchRoom } from "./scratch.ts";
import { dungeonOutcome, sceneContents, sendDungeon, type DungeonOutcome, type SendRoom } from "./send.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { NO_ANSWERS } from "../uvtt/rules.ts";

type Sent = { op: ClientOp; group: string | undefined; groupScope: string | undefined; onAnswer: OnAnswer | undefined; n: number | null };
type Shown = Pick<RoomView, "sceneId" | "sceneLoad" | "ended"> & { view: RoomState | null };

/** A made dungeon, and the room the server would hold once every op of it is taken. */
function made() {
  const plan = twoRooms();
  const preview = previewOf(DEFAULT_SETTINGS, "1K7QH2MXA9F3TWQ5", dialogScene(plan), () => plan);
  assert.ok(preview.ok);
  let id = 0;
  const fresh = withIds(preview.ops, () => `fresh-${++id}`);
  const stored = landAll(scratchRoom(), fresh.ops);
  assert.ok(stored.ok);
  return { made: { ops: fresh.ops, sceneId: fresh.sceneId, room: preview.room }, stored: stored.room };
}

/**
 * A room store and actions the test drives: dispatch records each op and
 * answers null where `refuseAtInput` says, and switchScene shows the asked
 * scene's stored contents after a tick, unless `loads` is off.
 */
function table(opts: { stored: RoomState | null; refuseAtInput?: (op: ClientOp, i: number) => boolean; loads?: boolean; shown?: boolean; checkMs?: number }) {
  let state: Shown = { sceneId: "start", view: { ...scratchRoom(), scenes: {} } as RoomState, ended: null };
  const listeners = new Set<(s: RoomView, was: RoomView) => void>();
  const set = (next: Partial<Shown>) => {
    const was = state;
    state = { ...state, ...next };
    for (const l of [...listeners]) l(state as unknown as RoomView, was as unknown as RoomView);
  };
  const sent: Sent[] = [];
  const switched: string[] = [];
  let n = 0;
  const actions = {
    newId: () => "group-1",
    dispatch(op: ClientOp, o?: { group?: string; groupScope?: string; onAnswer?: OnAnswer }) {
      const refused = opts.refuseAtInput?.(op, sent.length) ?? false;
      const at = refused ? null : ++n;
      sent.push({ op, group: o?.group, groupScope: o?.groupScope, onAnswer: o?.onAnswer, n: at });
      return at;
    },
    switchScene(sceneId: string) {
      switched.push(sceneId);
      set({ sceneLoad: { requested: sceneId } as RoomView["sceneLoad"] });
      if (opts.loads === false) return;
      setImmediate(() => set({ sceneId, sceneLoad: undefined, view: opts.stored }));
    },
  } as unknown as RoomActions;
  const store: SendRoom["store"] = {
    getState: () => state as unknown as RoomView,
    subscribe: (l: (s: RoomView, was: RoomView) => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
  // The scene exists in the DM's list once its create is taken, as the view predicts it.
  const listScene = (sceneId: string, room: RoomState | null) => {
    const scenes = { ...(state.view?.scenes ?? {}), ...(room?.scenes[sceneId] ? { [sceneId]: room.scenes[sceneId]! } : {}) };
    set({ view: { ...(state.view as RoomState), scenes } });
  };
  const room: SendRoom = { store, shown: () => opts.shown ?? true, ...(opts.checkMs !== undefined ? { checkMs: opts.checkMs } : {}) };
  return { actions, store, room, sent, switched, set, listScene, state: () => state };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function run(answers: (i: number, op: ClientOp) => OpAnswer, o: Omit<Parameters<typeof table>[0], "stored"> & { stored?: RoomState | null; exists?: boolean } = {}) {
  const { made: m, stored } = made();
  const t = table({ ...o, stored: o.stored === undefined ? stored : o.stored });
  const progress: [number, number][] = [];
  const done = sendDungeon(m, t.actions, (a, of) => progress.push([a, of]), t.room);
  const sentAtOnce = t.sent.length;
  if (o.exists ?? true) t.listScene(m.sceneId, stored);
  for (const [i, s] of t.sent.entries()) if (s.n !== null) s.onAnswer?.(answers(i, s.op));
  const outcome = await done;
  return { outcome, t, m, progress, sentAtOnce };
}

test("DG-B: every op is dispatched in one task, in one Setup group, and every answer is counted", async () => {
  const { outcome, t, m, progress, sentAtOnce } = await run(() => "taken");
  assert.equal(sentAtOnce, m.ops.length, "all dispatched before the first await");
  assert.deepEqual(t.sent.map((s) => s.op), m.ops);
  assert.ok(t.sent.every((s) => s.group === "group-1" && s.groupScope === "setup"));
  assert.deepEqual(progress, m.ops.map((_, i) => [i + 1, m.ops.length]));
  assert.deepEqual(outcome, { k: "complete", checked: false });
  assert.deepEqual(t.switched, [m.sceneId], "the scene opens");
});

test("DG-B: the scene refused by the server is none, and the scene refused at input sends nothing after it", async () => {
  const refused = await run((i) => (i === 0 ? "refused" : "refused"), { exists: false });
  assert.deepEqual(refused.outcome, { k: "none", lost: false });
  assert.deepEqual(refused.t.switched, []);
  const atInput = await run(() => "taken", { refuseAtInput: (_op, i) => i === 0, exists: false });
  assert.deepEqual(atInput.outcome, { k: "none", lost: false });
  assert.equal(atInput.t.sent.length, 1, "nothing after a scene the store would not send");
  assert.deepEqual(atInput.progress.at(-1), [atInput.m.ops.length, atInput.m.ops.length]);
});

test("DG-B: a refusal after the scene is partial, and a builder ask holding the queue counts as refused", async () => {
  const later = await run((i) => (i === 4 ? "refused" : "taken"));
  assert.deepEqual(later.outcome, { k: "partial" });
  assert.deepEqual(later.t.switched, [], "a partial dungeon is not opened for the DM");
  const held = await run(() => "taken", { refuseAtInput: (op) => op.t.startsWith("build.") });
  assert.deepEqual(held.outcome, { k: "partial" });
  assert.equal(held.t.sent.length, held.m.ops.length, "the rest still go");
});

test("DG-B: lost answers are checked against the stored scene: whole is complete, checked", async () => {
  const lost = await run((i) => (i % 3 === 1 ? "unknown" : "taken"));
  assert.deepEqual(lost.outcome, { k: "complete", checked: true });
  assert.deepEqual(lost.t.switched, [lost.m.sceneId], "opened once, to be compared");
});

test("DG-B: a lost refusal leaves the stored scene short, which is unconfirmed, and so is a scene that never shows", async () => {
  const { stored } = made();
  const short = structuredClone(stored);
  for (const chunk of Object.values(short.buildChunks)) delete chunk.edges["15,5,w"];
  const lostRefusal = await run((i) => (i === 4 ? "unknown" : "taken"), { stored: short });
  assert.deepEqual(lostRefusal.outcome, { k: "unconfirmed" });
  const noTrap = structuredClone(stored);
  noTrap.traps = Object.fromEntries(Object.entries(noTrap.traps).slice(0, 1));
  assert.deepEqual((await run((i) => (i === 9 ? "unknown" : "taken"), { stored: noTrap })).outcome, { k: "unconfirmed" });
  const expired = await run(() => "unknown", { loads: false, checkMs: 20 });
  assert.deepEqual(expired.outcome, { k: "unconfirmed" });
});

test("DG-B: lost answers with no scene after are none, lost", async () => {
  const gone = await run(() => "unknown", { exists: false });
  assert.deepEqual(gone.outcome, { k: "none", lost: true });
  assert.deepEqual(gone.t.switched, []);
});

test("DG-B: a hidden dialog whose DM moved on does not pull them to the new scene", async () => {
  const { made: m, stored } = made();
  const t = table({ stored, shown: false });
  const done = sendDungeon(m, t.actions, () => {}, t.room);
  t.listScene(m.sceneId, stored);
  t.set({ sceneId: "elsewhere" });
  for (const s of t.sent) s.onAnswer?.("unknown");
  assert.deepEqual(await done, { k: "unconfirmed" });
  assert.deepEqual(t.switched, []);
  const taken = table({ stored, shown: false });
  const whole = sendDungeon(m, taken.actions, () => {}, taken.room);
  taken.listScene(m.sceneId, stored);
  taken.set({ sceneId: "elsewhere" });
  for (const s of taken.sent) s.onAnswer?.("taken");
  assert.deepEqual(await whole, { k: "complete", checked: false });
  assert.deepEqual(taken.switched, [], "complete, but the DM is left where they went");
  const stayed = table({ stored, shown: false });
  const back = sendDungeon(m, stayed.actions, () => {}, stayed.room);
  stayed.listScene(m.sceneId, stored);
  for (const s of stayed.sent) s.onAnswer?.("unknown");
  assert.deepEqual(await back, { k: "complete", checked: true }, "hidden on the scene it started on, the check still runs");
});

test("DG-B: the compared contents leave out revs, walls versions, ids and order", () => {
  const { made: m, stored } = made();
  const again = structuredClone(stored);
  for (const chunk of Object.values(again.buildChunks)) chunk.rev += 7;
  for (const trap of Object.values(again.traps)) trap.rev += 3;
  again.scenes[m.sceneId]!.wallsVersion += 2;
  const scratchId = Object.keys(m.room.scenes)[0]!;
  assert.equal(sceneContents(again, m.sceneId), sceneContents(m.room, scratchId));
  const moved = structuredClone(stored);
  const trap = Object.values(moved.traps)[0]!;
  trap.state = "disarmed";
  assert.notEqual(sceneContents(moved, m.sceneId), sceneContents(m.room, scratchId));
  const stair = structuredClone(stored);
  for (const chunk of Object.values(stair.buildChunks)) delete chunk.up;
  assert.notEqual(sceneContents(stair, m.sceneId), sceneContents(m.room, scratchId));
});

/** The outcome rule, written out plainly, as the oracle for the randomized sends. */
function expected(answers: OpAnswer[], atInput: boolean[], exists: boolean, same: boolean, mayCheck: boolean): DungeonOutcome {
  const final = answers.map((a, i) => (atInput[0] ? "refused" : atInput[i] ? "refused" : a));
  if (final.every((a) => a === "taken")) return { k: "complete", checked: false };
  if (final[0] === "refused" || !exists) return { k: "none", lost: final[0] !== "refused" && final.includes("unknown") };
  if (final.includes("refused")) return { k: "partial" };
  return mayCheck && same ? { k: "complete", checked: true } : { k: "unconfirmed" };
}

test("DG-B: under any answers, in any order, refusals at input, a moved-on DM and a stored scene whole or short, the send ends once with the rule's outcome", async () => {
  const { made: m, stored } = made();
  const short = structuredClone(stored);
  for (const chunk of Object.values(short.buildChunks)) chunk.cells = {};
  const total = m.ops.length;
  const answer = fc.constantFrom<OpAnswer>("taken", "taken", "taken", "refused", "unknown", "unknown");
  const runs: { answers: OpAnswer[]; atInput: boolean[]; order: number[]; exists: boolean; same: boolean; shown: boolean; movedOn: boolean }[] = [];
  holds(
    fc.property(
      fc.array(answer, { minLength: total, maxLength: total }),
      fc.array(fc.constantFrom(false, false, false, false, true), { minLength: total, maxLength: total }),
      fc.shuffledSubarray([...Array(total).keys()], { minLength: total, maxLength: total }),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      (answers, atInput, order, exists, same, shown, movedOn) => void runs.push({ answers, atInput, order, exists, same, shown, movedOn }),
    ),
    200,
  );
  for (const r of runs) {
    const t = table({ stored: r.same ? stored : short, shown: r.shown, refuseAtInput: (_op, i) => r.atInput[i] === true, checkMs: 50 });
    const progress: number[] = [];
    let settled = 0;
    const done = sendDungeon(m, t.actions, (a) => progress.push(a), t.room).then((o) => {
      settled++;
      return o;
    });
    if (r.exists) t.listScene(m.sceneId, stored);
    if (r.movedOn) t.set({ sceneId: "elsewhere" });
    for (const i of r.order) {
      const s = t.sent[i];
      if (s && s.n !== null) s.onAnswer?.(r.answers[i]!);
      // An answer said twice, as a resend's late ack might, counts once.
      if (s && s.n !== null && i % 5 === 0) s.onAnswer?.("taken");
    }
    const outcome = await done;
    await flush();
    assert.equal(settled, 1);
    assert.deepEqual(progress, [...Array(total).keys()].map((k) => k + 1), "every op answered once, in count");
    const mayCheck = r.shown || !r.movedOn;
    assert.deepEqual(outcome, expected(r.answers, r.atInput, r.exists, r.same, mayCheck), JSON.stringify(r));
    if (r.atInput[0]) assert.equal(t.sent.length, 1, "nothing after a scene refused at input");
    const opens = t.switched.length;
    assert.ok(opens <= 1, "the scene opens at most once");
    if (opens === 1) assert.ok(mayCheck, "never pulls a DM who moved on");
    // It opens to be compared when answers were lost and none refused, or once complete.
    const final = r.answers.map((a, i) => (r.atInput[0] || r.atInput[i] ? "refused" : a));
    const compared = !final.includes("refused") && final.includes("unknown") && r.exists;
    assert.equal(opens === 1, mayCheck && (compared || final.every((a) => a === "taken")));
  }
});

test("DG-B: the outcome rule by itself", () => {
  const taken = { ...NO_ANSWERS, taken: 5 };
  assert.deepEqual(dungeonOutcome(taken, "taken", { exists: true, same: null }), { k: "complete", checked: false });
  assert.deepEqual(dungeonOutcome({ ...taken, refused: 1 }, "refused", { exists: false, same: null }), { k: "none", lost: false });
  assert.deepEqual(dungeonOutcome({ ...taken, unknown: 1 }, "unknown", { exists: false, same: null }), { k: "none", lost: true });
  assert.deepEqual(dungeonOutcome({ ...taken, refused: 1, unknown: 1 }, "taken", { exists: true, same: null }), { k: "partial" });
  assert.deepEqual(dungeonOutcome({ ...taken, unknown: 2 }, "taken", { exists: true, same: true }), { k: "complete", checked: true });
  assert.deepEqual(dungeonOutcome({ ...taken, unknown: 2 }, "taken", { exists: true, same: false }), { k: "unconfirmed" });
  assert.deepEqual(dungeonOutcome({ ...taken, unknown: 2 }, "taken", { exists: true, same: null }), { k: "unconfirmed" });
});
