import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LogEntry } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { room } from "#shared/testutil.ts";
import type { ScopeHistory } from "#shared/undoContract.ts";
import { describeOp } from "#server/rooms/undoLabels.ts";
import type { RoomView } from "../../state/types.ts";
import { ownKindOf, ownLineWatcher, settleClaims } from "./useClockToasts.ts";

const line = (id: string, from?: "undo" | "redo"): LogEntry => ({ id, at: "", kind: "event", data: { type: "clock", date: "Day 1, 8:00 AM", by: 600, ...(from ? { from } : {}) } });
const scope = (label: string | null, redo: string | null = null): ScopeHistory => ({
  undo: { head: label === null ? null : { id: "u1", label }, depth: label === null ? 0 : 1 },
  redo: { head: redo === null ? null : { id: "r1", label: redo }, depth: redo === null ? 0 : 1 },
});
const history = (label: string | null, redo: string | null = null) => ({ play: scope(label, redo), setup: scope(null) });

describe("ownKindOf", () => {
  it("claims only the clock ops that write a line", () => {
    assert.equal(ownKindOf({ t: "clock.advance" }, null), "step");
    assert.equal(ownKindOf({ t: "clock.set" }, null), "step");
    assert.equal(ownKindOf({ t: "clock.start" }, null), "step");
    assert.equal(ownKindOf({ t: "clock.update", at: 600 }, null), "step");
    assert.equal(ownKindOf({ t: "clock.update" }, null), null, "the sharing switch or a calendar-only save");
    assert.equal(ownKindOf({ t: "clock.stop" }, null), null);
    assert.equal(ownKindOf({ t: "token.move" }, null), null);
  });

  it("claims an undo or redo only when the head it names moved the clock", () => {
    assert.equal(ownKindOf({ t: "undo", head: "u1" }, history("moving the clock on 8 hours")), "history");
    assert.equal(ownKindOf({ t: "redo", head: "r1" }, history(null, "setting the date and time")), "history");
    assert.equal(ownKindOf({ t: "undo", head: "u1" }, history("moving Bree")), null, "a player's token undo");
    assert.equal(ownKindOf({ t: "undo", head: "u0" }, history("moving the clock on 8 hours")), null, "a head this device no longer holds");
    assert.equal(ownKindOf({ t: "undo", head: "u1", of: 3 }, history("moving the clock on 8 hours")), null);
    assert.equal(ownKindOf({ t: "undo", head: "u1", scope: "setup" }, { play: scope(null), setup: scope("changing the calendar") }), "history");
  });

  it("knows every label the server gives a step that moves the clock, and no other clock step's", () => {
    const before = room({ clock: { id: "c1", rev: 1, t: 0, shown: true, calendar: { kind: "days" } } });
    const label = (op: ClientOp) => describeOp(op, before);
    const moving: ClientOp[] = [
      { t: "clock.advance", by: 600 },
      { t: "clock.advance", by: 8 * 3_600, why: "longRest" },
      { t: "clock.set", at: 0 },
      { t: "clock.update", calendar: { kind: "days" } },
      { t: "clock.update", at: 60 },
    ];
    for (const op of moving) assert.equal(ownKindOf({ t: "undo", head: "u1" }, history(label(op))), "history", label(op));
    for (const op of [{ t: "clock.start", id: "c2", at: 0, shown: true, calendar: { kind: "days" } }, { t: "clock.stop" }, { t: "clock.update", shown: false }] as ClientOp[]) {
      assert.equal(ownKindOf({ t: "undo", head: "u1" }, history(label(op))), null, label(op));
    }
  });
});

describe("settleClaims", () => {
  it("takes the line of its kind that arrived with its answer", () => {
    assert.deepEqual(settleClaims([{ n: 3, kind: "step" }], new Set(), new Set(), [line("5:0")]), { mine: ["5:0"], left: [] });
    assert.deepEqual(settleClaims([{ n: 3, kind: "history" }], new Set(), new Set(), [line("5:0"), line("6:0", "undo")]).mine, ["6:0"]);
  });

  it("keeps a claim still waiting, and gives up one refused or answered with no line", () => {
    assert.deepEqual(settleClaims([{ n: 3, kind: "step" }], new Set([3]), new Set(), [line("5:0")]), { mine: [], left: [{ n: 3, kind: "step" }] });
    assert.deepEqual(settleClaims([{ n: 3, kind: "step" }], new Set(), new Set([3]), [line("5:0")]), { mine: [], left: [] }, "a refused op's update may carry another device's line");
    assert.deepEqual(settleClaims([{ n: 3, kind: "step" }], new Set(), new Set(), []), { mine: [], left: [] });
  });

  it("takes one line for one op", () => {
    assert.deepEqual(settleClaims([{ n: 3, kind: "step" }], new Set(), new Set(), [line("5:0"), line("6:0")]).mine, ["5:0"]);
  });
});

describe("ownLineWatcher (ASTRA-05)", () => {
  type State = Pick<RoomView, "pending" | "refused" | "confirmed" | "history">;
  function device(summary: ReturnType<typeof history> | null = null) {
    const watcher = ownLineWatcher();
    let state: State = { pending: [], refused: [], confirmed: { log: [] } as never, history: summary ? { summary: { t: "history", epoch: "e", seq: 0, serial: 0, watermark: 0, ...summary }, ready: true, pending: 0, slow: false, result: { play: null, setup: null } } : undefined };
    let n = 0;
    const to = (next: Partial<State>) => {
      const prev = state;
      state = { ...state, ...next };
      watcher.update(state, prev);
    };
    return {
      watcher,
      send(op: Record<string, unknown>) {
        const sent = ++n;
        to({ pending: [...state.pending, { n: sent, op: op as never, at: 0 }] });
        return sent;
      },
      /** The server's answer to `n`, with the clock lines its update brought. */
      answer(sent: number, lines: LogEntry[], refused = false) {
        to({ pending: state.pending.filter((p) => p.n !== sent), refused: refused ? [...(state.refused ?? []), sent] : state.refused, confirmed: { log: [...(state.confirmed?.log ?? []), ...lines] } as never });
      },
      /** Another device's line, in an update that answers nothing of this one's. */
      arrive(lines: LogEntry[]) {
        to({ confirmed: { log: [...(state.confirmed?.log ?? []), ...lines] } as never });
      },
    };
  }

  it("a co-DM's line after this device's sharing switch still toasts", () => {
    const d = device();
    d.answer(d.send({ t: "clock.update", shown: false }), []);
    d.arrive([line("7:0")]);
    assert.equal(d.watcher.take("7:0"), false);
  });

  it("a co-DM's line after this device's calendar-only save still toasts", () => {
    const d = device();
    const n = d.send({ t: "clock.update", calendar: { kind: "days" } });
    d.arrive([line("7:0")]);
    d.answer(n, []);
    assert.equal(d.watcher.take("7:0"), false);
  });

  it("a refused step claims nothing, not even a line in its refusal's update", () => {
    const d = device();
    d.answer(d.send({ t: "clock.advance", by: 600 }), [line("7:0")], true);
    d.arrive([line("8:0")]);
    assert.equal(d.watcher.take("7:0"), false);
    assert.equal(d.watcher.take("8:0"), false);
  });

  it("a player's token undo leaves the DM's undo line to toast", () => {
    const d = device(history("moving Bree"));
    d.answer(d.send({ t: "undo", head: "u1" }), [line("7:0", "undo")]);
    assert.equal(d.watcher.take("7:0"), false);
  });

  it("this device's own step and own undo of a clock step make no toast", () => {
    const d = device(history("moving the clock on 8 hours"));
    d.answer(d.send({ t: "clock.advance", by: 600 }), [line("7:0")]);
    assert.equal(d.watcher.take("7:0"), true);
    d.answer(d.send({ t: "undo", head: "u1" }), [line("8:0", "undo")]);
    assert.equal(d.watcher.take("8:0"), true);
  });

  it("a line that arrives while this device's step waits is another's", () => {
    const d = device();
    const n = d.send({ t: "clock.advance", by: 600 });
    d.arrive([line("7:0")]);
    d.answer(n, [line("8:0")]);
    assert.equal(d.watcher.take("7:0"), false);
    assert.equal(d.watcher.take("8:0"), true);
  });
});
