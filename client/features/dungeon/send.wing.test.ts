import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { serializedBytes } from "#shared/limits.ts";
import type { RoomState } from "#shared/model.ts";
import { ASK_LOST, clientOpSchema, MAX_ASK_BYTES, MAX_ASK_PARTS, type ClientOp, type OpOf } from "#shared/protocol.ts";
import { JOIN_CHANGED, joinChanged, WING_MOVED, wingClash, type WingClear } from "#shared/rules/wingClear.ts";
import type { OnAnswer, OpAnswer, OpRefusal, RoomActions, RoomView, UnknownCause } from "../../state/types.ts";
import { handKey, hexWingBase, hexWingSide, squareWingBase, WING_SETTINGS } from "./handPlans.ts";
import { wingIds } from "./ops.ts";
import type { WingBase } from "./plan.ts";
import { landAll, wingPreviewOf } from "./scratch.ts";
import { versionChar } from "./seed.ts";
import { asksSettled, sendWing, wingAsks, wingContents, type SendRoom, type WingOutcome } from "./send.ts";

/*
 * Sending a wing (docs/design: dungeon generator phase 3, 3.5 and 3.6):
 * its asks, the first refusal deciding, the forget question, the send in
 * one task with the key last, and the outcome from the answers.
 */

const SEED = "1Q8V2DR4HJ0Y7ZB3";
const keyFor = (_base: WingBase) => ({ ...handKey("Keep"), wing: { from: 0, titles: [], pins: 100 } });

/** A wing planned on a base and made with fresh ids, and the room the server would hold once all of it is taken. */
function madeWing(base: WingBase = hexWingBase().base, settings = WING_SETTINGS) {
  const preview = wingPreviewOf(settings, SEED, base, { feetPerCell: 5 }, keyFor(base));
  assert.ok(preview.ok && preview.clear, JSON.stringify(preview.ok ? "" : preview));
  let id = 0;
  let wall = 0;
  const fresh = wingIds(preview.ops, base.scene.id, base.scene.id, () => `fresh-${++id}`, undefined, () => `fw${String(++wall).padStart(10, "0")}`);
  const stored = landAll(base.state as RoomState, fresh.ops);
  assert.ok(stored.ok, stored.ok ? "" : stored.why);
  return { made: { ops: fresh.ops, ids: fresh.ids, room: preview.room, sceneId: base.scene.id, clear: preview.clear }, stored: stored.room, base };
}

type Sent = { op: ClientOp; group?: string; groupScope?: string; quiet?: boolean; onAnswer?: OnAnswer; n: number | null };

/** Actions and a store the test drives: the view is the base until `stored` is shown, each dispatch is recorded, Undo cancels the hold. */
function table(base: WingBase, opts: { refuseAtInput?: (op: ClientOp) => boolean } = {}) {
  let state = { sceneId: base.scene.id, view: base.state as RoomState, ended: null } as unknown as RoomView;
  const listeners = new Set<(s: RoomView, was: RoomView) => void>();
  const sent: Sent[] = [];
  let n = 0;
  let groups = 0;
  let holding: (() => void) | null = null;
  let released = 0;
  const dispatch = (op: ClientOp, o: Omit<Sent, "op" | "n"> = {}) => {
    const at = opts.refuseAtInput?.(op) ? null : ++n;
    sent.push({ op, ...o, n: at });
    return at;
  };
  const actions = {
    newId: () => `group-${++groups}`,
    dispatch,
    dispatchMany: (entries: { op: ClientOp; opts?: Omit<Sent, "op" | "n"> }[]) => entries.map((e) => dispatch(e.op, e.opts)),
    holdBuild(cancel: () => void) {
      holding = cancel;
      return () => {
        holding = null;
        released++;
      };
    },
  } as unknown as RoomActions;
  const store: SendRoom["store"] = {
    getState: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
  const show = (view: RoomState) => {
    const was = state;
    state = { ...state, view } as RoomView;
    for (const l of [...listeners]) l(state, was);
  };
  return { actions, room: { store, shown: () => true, checkMs: 50 } as SendRoom, sent, show, undo: () => holding?.(), released: () => released, holding: () => holding !== null };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const refusal = (code: OpRefusal["code"], message: string): OpRefusal => ({ code, message, text: message });

/** Answers every ask not yet answered, by its place among the asks. */
function answerAsks(t: ReturnType<typeof table>, from: number, answer: (i: number) => [OpAnswer, OpRefusal?, UnknownCause?]): number {
  const asks = t.sent.slice(from).filter((s) => s.op.t === "build.ask");
  asks.forEach((s, i) => {
    const [a, r, u] = answer(i);
    if (s.n !== null) s.onAnswer?.(a, r, u);
  });
  return t.sent.length;
}

/** Answers every op after the asks: `answer` by its place among the wing's ops as sent. */
function answerOps(t: ReturnType<typeof table>, answer: (op: ClientOp, i: number) => OpAnswer): void {
  const ops = t.sent.filter((s) => s.op.t !== "build.ask");
  ops.forEach((s, i) => {
    if (s.n !== null && !(s as { answered?: true }).answered) {
      (s as { answered?: true }).answered = true;
      s.onAnswer?.(answer(s.op, i));
    }
  });
}

async function send(m = madeWing(), opts: Parameters<typeof table>[1] & { ask?: boolean } = {}) {
  const t = table(m.base, opts);
  const asked: string[] = [];
  const progress: [number, number][] = [];
  const done = sendWing(m.made, t.actions, t.room, (a, of) => progress.push([a, of]), async (q) => (asked.push(q), opts.ask ?? true));
  return { t, m, done, asked, progress };
}

describe("a wing's asks", () => {
  test("pack its map ops in order with the clear on each, the smallest last and alone with the floor runs, each within the bytes", () => {
    const { made } = madeWing();
    const asks = wingAsks(made.sceneId, made.ops, made.clear)!;
    assert.ok(asks.length >= 2);
    const last = asks.at(-1)!;
    assert.equal(last.ops.length, 1, "the smallest goes alone");
    assert.deepEqual(last.clear, made.clear, "the runs ride the last part");
    assert.ok(made.clear.floor && made.clear.floor.length > 0);
    for (const [i, a] of asks.entries()) {
      assert.equal(a.part, i);
      assert.equal(a.more, i < asks.length - 1 ? true : undefined);
      assert.ok(serializedBytes(a) <= MAX_ASK_BYTES, `part ${i}: ${serializedBytes(a)}`);
      assert.ok(clientOpSchema.safeParse(a).success, `part ${i} parses`);
      if (i < asks.length - 1) assert.equal(a.clear?.floor, undefined, "no runs before the last part");
    }
    const sizes = asks.flatMap((a) => a.ops.map((op) => serializedBytes(op)));
    assert.equal(sizes.at(-1), Math.min(...sizes));
    assert.ok(asks.flatMap((a) => a.ops).every((op) => !("forget" in op)), "asked without the yes");
    // The asks carry every map op and stamp, and nothing else.
    const carried = asks.flatMap((a) => a.ops).length;
    assert.equal(carried, made.ops.filter((op) => op.t.startsWith("build.") && op.t !== "build.lights").length);
  });

  test("a wing past 16 asks gets none", () => {
    const { made } = madeWing();
    const walls = made.ops.find((op) => op.t === "build.walls" && (op.put?.length ?? 0) > 50)!;
    const many = Array.from({ length: MAX_ASK_PARTS * 2 }, () => walls);
    assert.equal(wingAsks(made.sceneId, many, made.clear), null);
    const fat: WingClear = { ...made.clear, floor: Array.from({ length: 4000 }, (_, i) => [i % 90, 1000, 1999] as [number, number, number]) };
    assert.equal(wingAsks(made.sceneId, made.ops, fat), null, "runs that cannot fit beside the smallest op");
  });

  test("the first refusal decides, and the lost answers after it are ignored", () => {
    const lost = { answer: "refused" as const, refusal: refusal("invalid", ASK_LOST) };
    assert.equal(asksSettled([{ answer: "taken" }, { answer: "taken" }]), "taken");
    assert.equal(asksSettled([{ answer: "refused", refusal: refusal("forget", "x") }, lost, lost]), "forget");
    assert.equal(asksSettled([{ answer: "refused", refusal: refusal("invalid", JOIN_CHANGED) }, lost]), "join");
    assert.equal(asksSettled([{ answer: "taken" }, { answer: "refused", refusal: refusal("invalid", WING_MOVED) }, lost]), "moved");
    assert.equal(asksSettled([{ answer: "refused", refusal: refusal("forbidden", "no") }, lost]), "none");
    assert.equal(asksSettled([lost, lost]), "lost", "lost before any refusal");
    assert.equal(asksSettled([{ answer: "taken" }, { answer: "unknown", unknown: "snapshot" }]), "lost");
    assert.equal(asksSettled([{ answer: "taken" }, { answer: "unknown", unknown: "expired" }]), "none");
    assert.equal(asksSettled([{ answer: "refused" }]), "none", "refused at input");
  });
});

describe("sending a wing", () => {
  test("asks taken: every op goes quiet in the asks' Setup group, the key's page after the rest is taken and before its pins", async () => {
    const { t, m, done, progress } = await send();
    const after = answerAsks(t, 0, () => ["taken"]);
    await flush();
    assert.ok(t.sent.slice(0, after).every((s) => s.op.t === "build.ask" && s.quiet === true && s.groupScope === "setup" && s.group === "group-1"));
    assert.equal(t.released(), 1, "the builder's hold ends once the asks are answered");
    const body = t.sent.slice(after);
    assert.ok(body.every((s) => s.quiet === true && s.group === "group-1" && s.groupScope === "setup"));
    assert.ok(!body.some((s) => s.op.t === "journal.create" || s.op.t === "pin.put"), "no key before the rest is taken");
    assert.ok(body.every((s) => !("forget" in s.op)), "no yes was needed");
    answerOps(t, () => "taken");
    await flush();
    const key = t.sent.slice(after + body.length).map((s) => s.op.t);
    assert.equal(key[0], "journal.create");
    assert.ok(key.length > 1 && key.slice(1).every((k) => k === "pin.put"));
    answerOps(t, () => "taken");
    assert.deepEqual(await done, { k: "complete", checked: false } satisfies WingOutcome);
    assert.deepEqual(progress[0], [0, m.made.ops.length], "the send starts after the asks");
    assert.deepEqual(progress.at(-1), [m.made.ops.length, m.made.ops.length]);
  });

  test("forget then Go ahead sends every asked op with the yes, and Cancel sends nothing", async () => {
    for (const yes of [true, false]) {
      const { t, done, asked } = await send(undefined, { ask: yes });
      const after = answerAsks(t, 0, (i) => (i === 0 ? ["refused", refusal("forget", "x")] : ["refused", refusal("invalid", ASK_LOST)]));
      await flush();
      assert.deepEqual(asked, ["forget"]);
      if (!yes) {
        assert.deepEqual(await done, { k: "none", lost: false });
        assert.equal(t.sent.length, after, "nothing sent");
        continue;
      }
      const body = t.sent.slice(after);
      assert.ok(body.length > 0);
      for (const s of body) assert.equal("forget" in s.op, s.op.t.startsWith("build.") && s.op.t !== "build.lights", s.op.t);
      answerOps(t, () => "taken");
      await flush();
      answerOps(t, () => "taken");
      assert.equal((await done).k, "complete");
    }
  });

  test("asks lost go again once under a new group, and lost twice adds nothing", async () => {
    const { t, done } = await send();
    let at = answerAsks(t, 0, () => ["unknown", undefined, "snapshot"]);
    await flush();
    assert.ok(t.sent.length > at && t.sent[at]!.group === "group-2", "asked again");
    at = answerAsks(t, at, () => ["taken"]);
    await flush();
    answerOps(t, () => "taken");
    await flush();
    answerOps(t, () => "taken");
    assert.equal((await done).k, "complete");

    const twice = await send();
    let from = answerAsks(twice.t, 0, () => ["refused", refusal("invalid", ASK_LOST)]);
    await flush();
    from = answerAsks(twice.t, from, () => ["unknown", undefined, "snapshot"]);
    await flush();
    assert.deepEqual(await twice.done, { k: "none", lost: true });
    assert.equal(twice.t.sent.length, from, "nothing but asks went");
  });

  test("a refused part is final: its lost followers are not asked again", async () => {
    const { t, done } = await send();
    const at = answerAsks(t, 0, (i) => (i === 0 ? ["refused", refusal("invalid", WING_MOVED)] : ["refused", refusal("invalid", ASK_LOST)]));
    assert.deepEqual(await done, { k: "moved" });
    assert.equal(t.sent.length, at);
    const join = await send();
    answerAsks(join.t, 0, (i) => (i === 0 ? ["taken"] : ["refused", refusal("invalid", JOIN_CHANGED)]));
    assert.deepEqual(await join.done, { k: "join" });
  });

  test("Undo while the asks wait sends nothing, and their late answers do nothing", async () => {
    const { t, done } = await send();
    const at = t.sent.length;
    assert.ok(t.holding());
    t.undo();
    assert.deepEqual(await done, { k: "none", lost: false });
    answerAsks(t, 0, () => ["taken"]);
    await flush();
    assert.equal(t.sent.length, at);
  });

  test("the first map op refused at input sends nothing after it, and a later refusal is partial with no key", async () => {
    const first = await send(undefined, { refuseAtInput: (op) => op.t !== "build.ask" });
    answerAsks(first.t, 0, () => ["taken"]);
    assert.deepEqual(await first.done, { k: "none", lost: false });
    assert.equal(first.t.sent.filter((s) => s.op.t !== "build.ask").length, 1);

    const later = await send();
    answerAsks(later.t, 0, () => ["taken"]);
    await flush();
    answerOps(later.t, (op) => (op.t === "trap.create" || op.t === "build.stamps" ? "refused" : "taken"));
    await flush();
    assert.deepEqual(await later.done, { k: "partial" });
    assert.ok(!later.t.sent.some((s) => s.op.t === "journal.create" || s.op.t === "pin.put"), "a failed wing leaves no key");
  });

  test("lost answers: the wing's part of the scene compared with the scratch room, complete when it matches, else unconfirmed", async () => {
    for (const matches of [true, false]) {
      const { t, m, done } = await send();
      answerAsks(t, 0, () => ["taken"]);
      await flush();
      answerOps(t, (op) => (op.t === "build.walls" ? "unknown" : "taken"));
      // A wall the server never stored reads as a different wing.
      const view = landAll(m.base.state as RoomState, m.made.ops.filter((op) => op.t !== "journal.create" && op.t !== "pin.put" && (matches || op.t !== "build.walls")));
      assert.ok(view.ok);
      t.show(view.room);
      assert.deepEqual(await done, matches ? { k: "complete", checked: true } : { k: "unconfirmed" });
    }
  });

  test("the device checks the join and the footprint on the room as it stands before it asks", async () => {
    const m = madeWing();
    const join = m.made.clear.join.grid === "hex" ? m.made.clear.join.walls[0]! : null!;
    const gone = landAll(m.base.state as RoomState, [{ t: "build.walls", sceneId: m.made.sceneId, remove: [{ cx: join.cx, cy: join.cy, id: join.id }] }]);
    assert.ok(gone.ok);
    const changed = await send({ ...m, base: { ...m.base, state: gone.room } });
    assert.deepEqual(await changed.done, { k: "join" });
    assert.equal(changed.t.sent.length, 0);
    const floorKey = m.made.clear.floor![3]!;
    const [x, y] = m.made.clear.floor ? [floorKey[1], floorKey[0]] : [0, 0];
    const label = landAll(m.base.state as RoomState, [{ t: "build.label", sceneId: m.made.sceneId, labelId: "lb1", label: { x: x + 0.5, y: y + 0.5, text: "Camp", size: 1 } }]);
    assert.ok(label.ok);
    void m.base.scene;
    const moved = await send({ ...m, base: { ...m.base, state: label.room } });
    assert.deepEqual(await moved.done, { k: "moved" });
  });
});

describe("a planned wing passes the server's checks on its base", () => {
  test("on squares and hexes, Narrow and Wide, flat, raised and sunk joins, over many seeds", () => {
    const bases: [string, WingBase][] = [
      ["squares", squareWingBase()],
      ["squares raised", squareWingBase({ ground: 5 })],
      ["squares wide", squareWingBase({ wide: true })],
      ["floor", squareWingBase({ rule: "floor" })],
      ["rows", hexWingBase("hexRows").base],
      ["columns", hexWingBase("hexColumns").base],
      ["rows raised", hexWingBase("hexRows", { ground: 5 }).base],
      ["columns sunk", hexWingBase("hexColumns", { ground: -10 }).base],
    ];
    let checked = 0;
    for (const [name, base] of bases) {
      for (let i = 0; i < 12; i++) {
        const seed = `${versionChar()}${String(i * 7919).padStart(15, "0")}`;
        const s = { ...WING_SETTINGS, wide: name.endsWith("wide"), heights: 40 };
        const p = wingPreviewOf(s, seed, base, { feetPerCell: 5 }, null);
        if (!p.ok) continue;
        checked++;
        const asks = wingAsks(base.scene.id, p.ops, p.clear!);
        assert.ok(asks && asks.length <= MAX_ASK_PARTS, `${name} ${seed}: asks`);
        assert.equal(joinChanged(base.state as RoomState, base.scene.id, p.clear!), false, `${name} ${seed}: join`);
        assert.equal(wingClash(base.state as RoomState, base.scene.id, asks.flatMap((a) => a.ops as OpOf<"build.ask">["ops"]), p.clear!), null, `${name} ${seed}: clash`);
        // The ops land on the base as the scratch room landed them, and the stored wing compares equal.
        let n = 0;
        const fresh = wingIds(p.ops, base.scene.id, base.scene.id, () => `id-${++n}`);
        const stored = landAll(base.state as RoomState, fresh.ops);
        assert.ok(stored.ok, `${name} ${seed}: ${stored.ok ? "" : stored.why}`);
        assert.equal(wingContents(stored.room, base.scene.id, fresh.ops, fresh.ids, true), wingContents(p.room, base.scene.id, fresh.ops, fresh.ids, false), `${name} ${seed}: same`);
      }
    }
    assert.ok(checked >= 60, `${checked} wings planned`);
  });

  test("on hexes, joined on each of a room's six sides at both parities, Narrow and Wide, flat, raised and sunk, on Hex rows and Hex columns", () => {
    // DG3 review round 1: a Wide join's slanted middle side read as a changed join, and a slanted side's approach clashed on the server.
    let checked = 0;
    for (const grid of ["hexRows", "hexColumns"] as const) {
      for (let dir = 0; dir < 6; dir++) {
        for (const odd of [false, true]) {
          for (const wide of [false, true]) {
            for (const ground of [0, 5, -10]) {
              const name = `${grid}, side ${dir}, ${odd ? "odd" : "even"} row, ${wide ? "Wide" : "Narrow"}, ${ground} ft`;
              const { base } = hexWingSide(grid, { dir, odd, wide, ground });
              const seed = `${versionChar()}${String(checked * 7919).padStart(15, "0")}`;
              const p = wingPreviewOf({ ...WING_SETTINGS, wide, heights: 40 }, seed, base, { feetPerCell: 5 }, null);
              assert.ok(p.ok && p.clear, `${name}: ${JSON.stringify(p.ok ? "no clear" : p)}`);
              const asks = wingAsks(base.scene.id, p.ops, p.clear);
              assert.ok(asks && asks.length <= MAX_ASK_PARTS, `${name}: asks`);
              assert.equal(joinChanged(base.state as RoomState, base.scene.id, p.clear), false, `${name}: join`);
              assert.equal(wingClash(base.state as RoomState, base.scene.id, asks.flatMap((a) => a.ops as OpOf<"build.ask">["ops"]), p.clear), null, `${name}: clash`);
              checked++;
            }
          }
        }
      }
    }
    assert.equal(checked, 144);
  });
});
