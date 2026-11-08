import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LogEntry } from "#shared/model.ts";
import type { RoomView } from "../../state/types.ts";
import { ownClaimOf, ownLineWatcher, settleClaims } from "./useClockToasts.ts";

const line = (id: string, claim?: string, from?: "undo" | "redo"): LogEntry => ({
  id,
  at: "",
  kind: "event",
  data: { type: "clock", date: "Day 1, 8:00 AM", by: 600, ...(from ? { from } : {}), ...(claim ? { claim } : {}) },
});

describe("ownClaimOf", () => {
  it("claims the clock ops that carry an id, and no other", () => {
    assert.equal(ownClaimOf({ t: "clock.advance", claim: "a1" }), "a1");
    assert.equal(ownClaimOf({ t: "clock.set", claim: "a2" }), "a2");
    assert.equal(ownClaimOf({ t: "clock.start", claim: "a3" }), "a3");
    assert.equal(ownClaimOf({ t: "clock.update", claim: "a4" }), "a4");
    assert.equal(ownClaimOf({ t: "clock.update" }), null, "the sharing switch or a calendar-only save sends none");
    assert.equal(ownClaimOf({ t: "clock.stop" }), null);
    assert.equal(ownClaimOf({ t: "token.move" }), null);
  });

  it("claims an undo or redo by the head it names, and not one that names a step by `of`", () => {
    assert.equal(ownClaimOf({ t: "undo", head: "u1" }), "u1");
    assert.equal(ownClaimOf({ t: "redo", head: "r1" }), "r1");
    assert.equal(ownClaimOf({ t: "undo", head: "u1", of: 3 }), null);
    assert.equal(ownClaimOf({ t: "undo" }), null);
  });
});

describe("settleClaims", () => {
  it("takes the line that carries its id, among the lines that arrived with its answer", () => {
    assert.deepEqual(settleClaims([{ n: 3, id: "a1" }], new Set(), new Set(), [line("5:0", "zz"), line("6:0", "a1")]), { mine: ["6:0"], left: [] });
    assert.deepEqual(settleClaims([{ n: 3, id: "u1" }], new Set(), new Set(), [line("5:0", "u1", "undo")]).mine, ["5:0"]);
  });

  it("keeps a claim still waiting, and gives up one refused or answered with no line of its id", () => {
    assert.deepEqual(settleClaims([{ n: 3, id: "a1" }], new Set([3]), new Set(), [line("5:0", "a1")]), { mine: [], left: [{ n: 3, id: "a1" }] });
    assert.deepEqual(settleClaims([{ n: 3, id: "a1" }], new Set(), new Set([3]), [line("5:0", "a1")]), { mine: [], left: [] }, "a refused op's update may carry another device's line");
    assert.deepEqual(settleClaims([{ n: 3, id: "a1" }], new Set(), new Set(), [line("5:0")]), { mine: [], left: [] }, "a line with no claim is another's");
  });

  it("two same-kind lines in one batch, one this device's, are told apart by their ids", () => {
    const arrived = [line("5:0", "theirs"), line("6:0", "mine")];
    assert.deepEqual(settleClaims([{ n: 3, id: "mine" }], new Set(), new Set(), arrived).mine, ["6:0"]);
    assert.deepEqual(settleClaims([{ n: 3, id: "mine" }], new Set(), new Set(), [...arrived].reverse()).mine, ["6:0"]);
  });
});

describe("ownLineWatcher (ASTRA-05)", () => {
  type State = Pick<RoomView, "pending" | "refused" | "confirmed" | "history">;
  function device() {
    const watcher = ownLineWatcher();
    let state: State = { pending: [], refused: [], confirmed: { log: [] } as never, history: undefined };
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
    d.arrive([line("7:0", "theirs")]);
    assert.equal(d.watcher.take("7:0"), false);
  });

  it("a co-DM's line after this device's calendar-only save still toasts", () => {
    const d = device();
    const n = d.send({ t: "clock.update", calendar: { kind: "days" } });
    d.arrive([line("7:0", "theirs")]);
    d.answer(n, []);
    assert.equal(d.watcher.take("7:0"), false);
  });

  it("a refused step claims nothing, not even a line in its refusal's update", () => {
    const d = device();
    d.answer(d.send({ t: "clock.advance", by: 600, claim: "a1" }), [line("7:0", "a1")], true);
    d.arrive([line("8:0", "a1")]);
    assert.equal(d.watcher.take("7:0"), false);
    assert.equal(d.watcher.take("8:0"), false);
  });

  it("a player's token undo leaves the DM's undo line to toast", () => {
    const d = device();
    d.answer(d.send({ t: "undo", head: "u1" }), [line("7:0", "other-head", "undo")]);
    assert.equal(d.watcher.take("7:0"), false);
  });

  it("this device's own step and own undo make no toast", () => {
    const d = device();
    d.answer(d.send({ t: "clock.advance", by: 600, claim: "a1" }), [line("7:0", "a1")]);
    assert.equal(d.watcher.take("7:0"), true);
    d.answer(d.send({ t: "undo", head: "u1" }), [line("8:0", "u1", "undo")]);
    assert.equal(d.watcher.take("8:0"), true);
  });

  it("a same-kind line of a co-DM in the same update is not this device's", () => {
    const d = device();
    d.answer(d.send({ t: "clock.advance", by: 600, claim: "a1" }), [line("7:0", "theirs"), line("8:0", "a1")]);
    assert.equal(d.watcher.take("7:0"), false);
    assert.equal(d.watcher.take("8:0"), true);
  });

  it("a line that arrives while this device's step waits is another's", () => {
    const d = device();
    const n = d.send({ t: "clock.advance", by: 600, claim: "a1" });
    d.arrive([line("7:0", "theirs")]);
    d.answer(n, [line("8:0", "a1")]);
    assert.equal(d.watcher.take("7:0"), false);
    assert.equal(d.watcher.take("8:0"), true);
  });
});
