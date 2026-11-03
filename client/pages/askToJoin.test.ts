import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError, type Me } from "../lib/api.ts";
import { MEMBER_COLORS } from "../lib/theme.ts";
import {
  advance,
  askStartColor,
  BACKOFF_MS,
  COMPLETE_RETRY_MS,
  completeWithRecovery,
  effectOf,
  hasMember,
  initialAskState,
  OUTCOME_CARDS,
  outcomeButtons,
  reconnecting,
  waitingLine,
  type AskEvent,
  type AskState,
  type Effect,
} from "./askToJoin.ts";

const ME = { member: { id: "m1", name: "Quinn", color: "#fff", kind: "player" }, role: "player" } as unknown as Me;

/** Plays events through the reducer as the page does, keeping the effects it asked for. */
function drive(events: readonly AskEvent[], from: AskState = initialAskState()) {
  let state = from;
  let issued = 0;
  const effects: Effect[] = [];
  for (const event of events) {
    const next = advance(state, event, issued);
    state = next.state;
    if (next.effect) {
      effects.push(next.effect);
      if ("seq" in next.effect) issued = Math.max(issued, next.effect.seq);
    }
  }
  return { state, effects };
}

const asked: AskEvent[] = [{ type: "send" }, { type: "asked", requestId: "r1", name: "Quinn" }];

describe("the ask page's wait loop", () => {
  test("an ask starts a wait for its request, and a waiting answer starts the next one", () => {
    const first = drive(asked);
    assert.deepEqual(first.effects, [{ kind: "wait", requestId: "r1", seq: 1 }]);
    const second = drive([{ type: "answer", seq: 1, requestId: "r1", state: "waiting" }], first.state);
    assert.deepEqual(second.effects, [{ kind: "wait", requestId: "r1", seq: 2 }]);
  });

  test("a locked phone's wait that comes back after minutes is simply the next wait", () => {
    // Nothing in the page ends a request: only the server's answer does (design 10.1, a phone locked for 9 minutes).
    let run = drive(asked);
    for (let i = 1; i <= 20; i++) run = drive([{ type: "answer", seq: i, requestId: "r1", state: "waiting" }], run.state);
    assert.equal(run.state.kind, "waiting");
  });

  test("let in: the answer carries the member and the page opens the room", () => {
    const run = drive([{ type: "answer", seq: 1, requestId: "r1", state: "in", me: ME }], drive(asked).state);
    assert.deepEqual(run.state, { kind: "in", me: ME });
    assert.deepEqual(run.effects, []);
  });

  test("each ending answer shows its card and starts no call", () => {
    for (const ending of ["turned_away", "expired", "closed"] as const) {
      const run = drive([{ type: "answer", seq: 1, requestId: "r1", state: ending }], drive(asked).state);
      assert.deepEqual(run.state, { kind: "outcome", outcome: ending, requestId: "r1", name: null });
      assert.deepEqual(run.effects, []);
    }
  });

  test("superseded stops this page for good until Wait here, which waits again on the same request", () => {
    const stopped = drive([{ type: "answer", seq: 1, requestId: "r1", state: "superseded" }], drive(asked).state);
    assert.equal(stopped.state.kind === "outcome" && stopped.state.outcome, "other_tab");
    assert.deepEqual(stopped.effects, []);
    const back = drive([{ type: "waitHere" }], stopped.state);
    assert.equal(back.state.kind, "waiting");
    assert.equal(back.effects[0]?.kind, "wait");
  });

  test("a failed wait pauses 1, 2 and 5 s and no longer, and says it is reconnecting", () => {
    let run = drive(asked);
    const pauses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const waitSeq = (run.state.kind === "waiting" ? run.state.io.seq : 0);
      run = drive([{ type: "waitFailed", seq: waitSeq, requestId: "r1", gone: false }], run.state);
      const sleep = run.effects.find((e) => e.kind === "sleep");
      if (!sleep || sleep.kind !== "sleep") throw new Error("no pause");
      pauses.push(sleep.ms);
      assert.equal(reconnecting(run.state), true);
      run = drive([{ type: "slept", seq: sleep.seq }], run.state);
    }
    assert.deepEqual(pauses, [1000, 2000, 5000, 5000, 5000, 5000]);
    assert.deepEqual([...BACKOFF_MS], [1000, 2000, 5000]);
    // An answer ends the reconnecting line.
    run = drive([{ type: "answer", seq: run.state.kind === "waiting" ? run.state.io.seq : 0, requestId: "r1", state: "waiting" }], run.state);
    assert.equal(reconnecting(run.state), false);
  });

  test("a wait that finds its request gone asks GET /me before saying the request ended", () => {
    const gone = drive([{ type: "waitFailed", seq: 1, requestId: "r1", gone: true }], drive(asked).state);
    assert.equal(gone.state.kind, "checking");
    assert.equal(gone.effects[0]?.kind, "me");
    const entered = drive([{ type: "meResult", seq: 2, me: ME }], gone.state);
    assert.equal(entered.state.kind, "in");
    const ended = drive([{ type: "meResult", seq: 2, me: null }], gone.state);
    assert.deepEqual(ended.state, { kind: "outcome", outcome: "ended", requestId: "r1", name: null });
  });

  test("a me check that cannot reach the server tries three more times, then the request ended", () => {
    let run = drive([{ type: "waitFailed", seq: 1, requestId: "r1", gone: true }], drive(asked).state);
    for (let i = 0; i < 3; i++) {
      const seq = run.state.kind === "checking" ? run.state.io.seq : 0;
      run = drive([{ type: "meResult", seq, me: "error" }], run.state);
      assert.equal(run.state.kind, "checking");
      const sleep = run.effects.at(-1);
      assert.equal(sleep?.kind, "sleep");
      run = drive([{ type: "slept", seq: sleep?.kind === "sleep" ? sleep.seq : 0 }], run.state);
    }
    const seq = run.state.kind === "checking" ? run.state.io.seq : 0;
    run = drive([{ type: "meResult", seq, me: "error" }], run.state);
    assert.equal(run.state.kind === "outcome" && run.state.outcome, "ended");
  });

  test("an ask answered already_in asks GET /me and opens the room when the grant is there", () => {
    const run = drive([{ type: "send" }, { type: "alreadyIn" }]);
    assert.equal(run.state.kind, "checking");
    assert.deepEqual(drive([{ type: "meResult", seq: 1, me: ME }], run.state).state, { kind: "in", me: ME });
  });

  test("cancel sends once, a 204 returns to the form, and a late wait answer moves nothing", () => {
    const cancelled = drive([{ type: "cancel" }, { type: "cancel" }], drive(asked).state);
    assert.deepEqual(cancelled.effects, [{ kind: "cancel", requestId: "r1" }]);
    const done = drive([{ type: "cancelDone", requestId: "r1" }], cancelled.state);
    assert.deepEqual(done.state, { kind: "form" });
    const late = drive([{ type: "answer", seq: 1, requestId: "r1", state: "in", me: ME }], done.state);
    assert.deepEqual(late.state, { kind: "form" });
  });

  test("cancel refused while a let-in commits waits again, and the let-in still opens the room", () => {
    const deciding = drive([{ type: "cancel" }, { type: "cancelDeciding", requestId: "r1" }], drive(asked).state);
    assert.equal(deciding.state.kind === "waiting" && deciding.state.cancel, "deciding");
    assert.deepEqual(deciding.effects.at(-1), { kind: "wait", requestId: "r1", seq: 2 }, "the wait Cancel cut off starts again");
    const entered = drive([{ type: "answer", seq: 2, requestId: "r1", state: "in", me: ME }], deciding.state);
    assert.equal(entered.state.kind, "in");
  });

  test("Cancel cuts off its held wait, so the wait's 404 and Cancel's 204 land in either order on the form (JB-ASTRA-06)", () => {
    const sent = drive([{ type: "cancel" }], drive(asked).state);
    assert.equal(sent.state.kind === "waiting" && sent.state.io.step, "idle", "no wait in flight while Cancel is out, so the page cuts the held one off");
    // The 404 first: it belongs to a wait the page no longer runs.
    const goneFirst = drive([{ type: "waitFailed", seq: 1, requestId: "r1", gone: true }, { type: "cancelDone", requestId: "r1" }], sent.state);
    assert.deepEqual(goneFirst.state, { kind: "form" });
    assert.deepEqual(goneFirst.effects, [], "and nothing new starts");
    // The 204 first.
    const doneFirst = drive([{ type: "cancelDone", requestId: "r1" }, { type: "waitFailed", seq: 1, requestId: "r1", gone: true }], sent.state);
    assert.deepEqual(doneFirst.state, { kind: "form" });
    // A cancel that failed outright waits on.
    const failed = drive([{ type: "cancelFailed", requestId: "r1", gone: false }], sent.state);
    assert.deepEqual(failed.effects, [{ kind: "wait", requestId: "r1", seq: 2 }]);
  });

  test("a cancel that finds the request gone asks GET /me rather than showing a card or the form", () => {
    const run = drive([{ type: "cancel" }, { type: "cancelFailed", requestId: "r1", gone: true }], drive(asked).state);
    assert.equal(run.state.kind, "checking");
    const failed = drive([{ type: "cancel" }, { type: "cancelFailed", requestId: "r1", gone: false }], drive(asked).state);
    assert.equal(failed.state.kind === "waiting" && failed.state.cancelFailed, true);
  });

  test("a request found on load goes straight to its card or its wait", () => {
    const waiting = drive([{ type: "found", requestId: "r9", name: "Quinn", state: "waiting" }]);
    assert.deepEqual(waiting.effects, [{ kind: "wait", requestId: "r9", seq: 1 }]);
    const away = drive([{ type: "found", requestId: "r9", name: "Quinn", state: "turned_away" }]);
    assert.equal(away.state.kind === "outcome" && away.state.outcome, "turned_away");
    // A request already let in is checked, not assumed.
    const entered = drive([{ type: "found", requestId: "r9", name: "Quinn", state: "in" }]);
    assert.equal(entered.effects[0]?.kind, "me");
  });

  test("a refused ask returns to the form", () => {
    assert.deepEqual(drive([{ type: "send" }, { type: "askFailed" }]).state, { kind: "form" });
  });

  test("a call cut off by the page going away starts again, never twice", () => {
    const inflight = drive(asked).state;
    const rewound = drive([{ type: "rewind" }], inflight);
    assert.equal(rewound.effects.length, 1);
    assert.deepEqual(rewound.effects[0], { kind: "wait", requestId: "r1", seq: 2 });
    // The cut-off call's answer is for a seq nobody waits on.
    const stale = drive([{ type: "answer", seq: 1, requestId: "r1", state: "in", me: ME }], rewound.state);
    assert.equal(stale.state, rewound.state);
  });

  test("a new request after an old one numbers its calls above the old ones", () => {
    const first = drive([...asked, { type: "answer", seq: 1, requestId: "r1", state: "expired" }, { type: "reset" }, ...asked.map((e) => (e.type === "asked" ? { ...e, requestId: "r2" } : e))]);
    assert.deepEqual(first.effects.at(-1), { kind: "wait", requestId: "r2", seq: 2 });
  });
});

describe("a GET /me answer that opens the room", () => {
  test("needs its member: a grant without one is not a way in", () => {
    assert.equal(hasMember(ME), true);
    assert.equal(hasMember({ role: "player", roomName: "Crypt" } as unknown as Me), false);
    assert.equal(hasMember({ role: "player", member: null } as unknown as Me), false);
  });
});

describe("the ask page's words", () => {
  test("every ending card says what the design says", () => {
    assert.deepEqual(OUTCOME_CARDS.turned_away, { title: "The DM said no", body: "You can ask again in 15 minutes." });
    assert.deepEqual(OUTCOME_CARDS.expired, { title: "No answer yet", body: "The DM may be away. Ask again later, or ask the DM for the player link." });
    assert.deepEqual(OUTCOME_CARDS.closed, { title: "Requests are off", body: "The DM stopped taking requests." });
    assert.deepEqual(OUTCOME_CARDS.other_tab, { title: "Waiting in another tab", body: "This request is waiting in another tab or window." });
    assert.deepEqual(OUTCOME_CARDS.ended, { title: "Request ended", body: "That request ended. Ask again." });
    assert.equal(waitingLine("Quinn"), "You asked to join as Quinn.");
  });

  test("each ending offers the buttons of the design's table", () => {
    assert.deepEqual(outcomeButtons("turned_away"), ["back"]);
    assert.deepEqual(outcomeButtons("expired"), ["again", "back"]);
    assert.deepEqual(outcomeButtons("closed"), []);
    assert.deepEqual(outcomeButtons("other_tab"), ["here"]);
    assert.deepEqual(outcomeButtons("ended"), ["again"]);
  });

  test("the ask card starts on the first color that is not the DM's yellow", () => {
    assert.equal(askStartColor(), MEMBER_COLORS[1]);
  });

  test("no call is due on a form, a card or an open room", () => {
    assert.equal(effectOf(initialAskState()), null);
    assert.equal(effectOf({ kind: "in", me: ME }), null);
  });
});

describe("finishing the player join while the server settles it", () => {
  const busy = new ApiError(503, "Busy.", "busy", null);
  const recoverable = (err: unknown) => err instanceof ApiError && (err.code === "busy" || err.code === "already_in");

  test("a busy answer asks GET /me first and enters if the join went through", async () => {
    let completions = 0;
    const slept: number[] = [];
    const me = await completeWithRecovery({
      complete: () => {
        completions++;
        return Promise.reject(busy);
      },
      getMe: () => Promise.resolve(ME),
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      recoverable,
    });
    assert.equal(me, ME);
    assert.equal(completions, 1);
    assert.deepEqual(slept, []);
  });

  test("otherwise it tries again after 1, 2 and 5 s, and the retry joins once the ticket is back", async () => {
    let completions = 0;
    const slept: number[] = [];
    const me = await completeWithRecovery({
      complete: () => (++completions < 3 ? Promise.reject(busy) : Promise.resolve(ME)),
      getMe: () => Promise.resolve(null),
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      recoverable,
    });
    assert.equal(me, ME);
    assert.deepEqual(slept, [1000, 2000]);
    assert.deepEqual([...COMPLETE_RETRY_MS], [1000, 2000, 5000]);
  });

  test("after the last retry it gives the busy error back for the page to word", async () => {
    const slept: number[] = [];
    await assert.rejects(
      completeWithRecovery({
        complete: () => Promise.reject(busy),
        getMe: () => Promise.reject(new Error("down")),
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
        recoverable,
      }),
      busy,
    );
    assert.deepEqual(slept, [1000, 2000, 5000]);
  });

  test("any other refusal is the caller's at once", async () => {
    const refused = new ApiError(401, "No.", "bad_ticket" as never, null);
    await assert.rejects(
      completeWithRecovery({ complete: () => Promise.reject(refused), getMe: () => Promise.resolve(ME), sleep: () => Promise.resolve(), recoverable }),
      refused,
    );
  });
});
