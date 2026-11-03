import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ADMISSION_DEADLINE_MS,
  ENDED_KEEP_MS,
  GENERATION_KEEP_MS,
  JoinRequests,
  REFUSAL_SHOWN_MS,
  REQUEST_LIFE_MS,
  TURN_AWAY_HOLD_MS,
  WAIT_HOLD_MS,
  type OwedHold,
  type Refusal,
  type Reservation,
  type Timers,
} from "./joinRequests.ts";

const ROOM = "ROOMAAAA";
const OTHER = "ROOMBBBB";

/** A clock and timers the test moves by hand. */
class FakeTime implements Timers {
  now = 1_000_000;
  #timers = new Map<number, { at: number; fn: () => void }>();
  #next = 1;
  set(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.now + ms, fn });
    return id;
  }
  clear(handle: unknown): void {
    this.#timers.delete(handle as number);
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.#timers]) {
      if (t.at <= this.now) {
        this.#timers.delete(id);
        t.fn();
      }
    }
  }
  get pending(): number {
    return this.#timers.size;
  }
}

function setup() {
  const time = new FakeTime();
  const store = new JoinRequests({ now: () => time.now, timers: time });
  const ask = (sessionId: string, opts: { room?: string; ip?: string; startedAt?: number } = {}) => {
    const room = opts.room ?? ROOM;
    const res = store.reserve(room, opts.ip ?? "203.0.113.1", opts.startedAt ?? time.now, store.generation(room));
    assert.ok("id" in res, "a place was free");
    return res;
  };
  const admit = (res: Reservation, sessionId: string, name = "Quinn") => store.admit(res, { sessionId, name, color: "#3e8ef7" });
  const asked = (sessionId: string, opts: { room?: string; ip?: string } = {}) => {
    const out = admit(ask(sessionId, opts), sessionId);
    assert.ok(out.ok, JSON.stringify(out));
    return out.request;
  };
  return { time, store, ask, admit, asked };
}

const code = (r: { ok: boolean } | Refusal) => ("code" in r ? r.code : "ok");

describe("join requests: the ask", () => {
  test("an ask paused before final admission meets whatever happened to the device's earlier request", () => {
    // A let-in took it: request_deciding, the earlier request untouched.
    {
      const { store, ask, admit, asked } = setup();
      const first = asked("s1");
      const paused = ask("s1");
      assert.ok(store.take(ROOM, first.id).ok);
      assert.equal(code(admit(paused, "s1")), "request_deciding");
      assert.equal(store.get(first.id)?.state, "deciding");
    }
    // The let-in went through: already_in.
    {
      const { store, ask, admit, asked } = setup();
      const first = asked("s1");
      const paused = ask("s1");
      store.take(ROOM, first.id);
      store.settle(first.id, "in");
      assert.equal(code(admit(paused, "s1")), "already_in");
      assert.equal(store.get(first.id)?.state, "in");
    }
    // A DM turned it away: asked_recently, with the hold's own Retry-After.
    {
      const { store, ask, admit, asked } = setup();
      const first = asked("s1");
      const paused = ask("s1");
      store.turnAway(ROOM, [first.id]);
      const refused = admit(paused, "s1");
      assert.equal(code(refused), "asked_recently");
      assert.equal("retryAfter" in refused && refused.retryAfter, TURN_AWAY_HOLD_MS / 1000);
    }
    // Its session joined by password meanwhile: already_in.
    {
      const { store, ask, admit, asked } = setup();
      const first = asked("s1");
      const paused = ask("s1");
      store.gotIn(ROOM, "s1");
      assert.equal(code(admit(paused, "s1")), "already_in");
      assert.equal(store.get(first.id)?.state, "gone");
    }
  });

  test("a mark refuses only the asks that started before it", () => {
    const { time, store, ask, admit } = setup();
    store.gotIn(ROOM, "s1");
    time.advance(1);
    assert.equal(code(admit(ask("s1"), "s1")), "ok", "an ask begun after the mark goes on to the database's own grant check");
  });

  test("an ask past its 30 s deadline is busy, and one within it still meets a password join", () => {
    const { time, store, ask, admit } = setup();
    const late = ask("s1");
    time.advance(ADMISSION_DEADLINE_MS + 1);
    assert.equal(code(admit(late, "s1")), "busy");
    const inTime = ask("s2");
    time.advance(ADMISSION_DEADLINE_MS - 1);
    store.gotIn(ROOM, "s2");
    assert.equal(code(admit(inTime, "s2")), "already_in");
    assert.equal([...store.reservations()].length, 0, "RESERVE: both places given back");
  });

  test("a new ask from the same device replaces its waiting request, which ends as gone", () => {
    const { store, asked } = setup();
    const first = asked("s1");
    const second = asked("s1");
    assert.equal(store.get(first.id)?.state, "gone");
    assert.equal(store.mine(ROOM, "s1")?.id, second.id);
    assert.deepEqual(store.list(ROOM).map((r) => r.id), [second.id]);
  });

  test("an ask racing a switch to With the password or a delete is refused, never left waiting", () => {
    const { store, ask, admit } = setup();
    const before = ask("s1");
    store.closeRoom(ROOM);
    assert.equal(code(admit(before, "s1")), "asks_off");
    const beforeDelete = ask("s2");
    store.dropRoom(ROOM);
    assert.equal(code(admit(beforeDelete, "s2")), "room_not_found");
    assert.equal(store.list(ROOM).length, 0);
  });

  test("a room's generation is forgotten once nothing in it is live, and an ask that read it before the bump is still refused (JBO1-10)", () => {
    const { time, store, asked, admit } = setup();
    const startedAt = time.now;
    const before = store.generation(ROOM);
    store.closeRoom(ROOM);
    store.dropRoom(OTHER);
    const live = asked("s1");
    time.advance(GENERATION_KEEP_MS);
    store.sweep();
    assert.notEqual(store.generation(ROOM), before, "kept while a request waits in the room");
    assert.equal(store.generation(OTHER), 0, "a deleted room with nothing live is forgotten");
    store.cancel(ROOM, live.id, "s1");
    store.sweep();
    assert.equal(store.generation(ROOM), 0, "then this one too");
    // The ask read the number before the bump: its deadline refuses it, never the forgotten number.
    const stale = store.reserve(ROOM, "203.0.113.9", startedAt, before);
    assert.ok("id" in stale);
    assert.equal(code(admit(stale, "s9")), "busy");
    // A bump after the prune never repeats an old number.
    store.closeRoom(ROOM);
    assert.notEqual(store.generation(ROOM), 0);
    assert.notEqual(store.generation(ROOM), before);
  });

  test("a sweep right after a bump keeps the generation, so an ask that read it before the bump is still refused (JBO1-10)", () => {
    const { time, store, admit } = setup();
    // The ask reads the generation, then the mode, before it reserves a place.
    const read = store.generation(ROOM);
    store.closeRoom(ROOM);
    const bumped = store.generation(ROOM);
    store.sweep();
    time.advance(1_000);
    store.sweep();
    const place = store.reserve(ROOM, "203.0.113.9", time.now, read);
    assert.ok("id" in place);
    assert.equal(code(admit(place, "s9")), "asks_off", "GENERATION: never admitted across the switch");
    // Forgotten and bumped again, the room never shows a number read before.
    time.advance(GENERATION_KEEP_MS);
    store.sweep();
    store.closeRoom(ROOM);
    assert.notEqual(store.generation(ROOM), bumped);
  });

  test("an ask that read a generation forgotten before it reserved is admitted, and its let-in that fails waits again: a prune is no bump (JBO2-01)", () => {
    const { time, store, admit } = setup();
    store.closeRoom(ROOM);
    time.advance(GENERATION_KEEP_MS);
    const read = store.generation(ROOM);
    assert.notEqual(read, 0);
    store.sweep();
    assert.equal(store.generation(ROOM), 0, "forgotten between the read and the reserve");
    const place = store.reserve(ROOM, "203.0.113.9", time.now, read);
    assert.ok("id" in place);
    const out = admit(place, "s9");
    assert.ok(out.ok, JSON.stringify(out));
    store.take(ROOM, out.request.id);
    store.settle(out.request.id, "failed");
    assert.equal(store.get(out.request.id)?.state, "waiting", "the room still takes asks");
    // A bump since the read still refuses, however old the read.
    store.closeRoom(ROOM);
    const after = store.reserve(ROOM, "203.0.113.10", time.now, read);
    assert.ok("id" in after);
    assert.equal(code(admit(after, "s10")), "asks_off");
  });

  test("the caps: 8 waiting per address per room, 50 per room, 500 on the server, places reserved counted", () => {
    const { store, ask, asked } = setup();
    for (let i = 0; i < 7; i++) asked(`a${i}`);
    ask("a7");
    assert.equal(code(store.reserve(ROOM, "203.0.113.1", 0, 0) as Refusal), "asks_full", "the 9th from one address");
    for (let i = 0; i < 42; i++) asked(`b${i}`, { ip: `198.51.100.${i}` });
    assert.equal(code(store.reserve(ROOM, "192.0.2.9", 0, 0) as Refusal), "asks_full", "the 51st in a room");
    for (let room = 0; room < 9; room++) for (let i = 0; i < 50; i++) asked(`r${room}-${i}`, { room: `ROOM${room}XXX`, ip: `198.51.${room}.${i}` });
    assert.equal(code(store.reserve(OTHER, "192.0.2.10", 0, 0) as Refusal), "asks_full", "the 501st on the server");
  });
});

describe("join requests: waiting", () => {
  test("a wait holds 25 s and answers waiting, and a locked phone's next wait after 9 minutes still finds it", async () => {
    const { time, store, asked } = setup();
    const r = asked("s1");
    const held = store.wait(ROOM, r.id, "s1");
    assert.ok(held);
    time.advance(WAIT_HOLD_MS);
    assert.equal(await held.answer, "waiting");
    time.advance(9 * 60_000);
    const later = store.wait(ROOM, r.id, "s1");
    assert.ok(later);
    store.take(ROOM, r.id);
    store.settle(r.id, "in");
    assert.equal(await later.answer, "in");
  });

  test("a wrong session, another room or an unknown id is refused before any held wait is touched", async () => {
    const { store, asked } = setup();
    const r = asked("s1");
    const held = store.wait(ROOM, r.id, "s1");
    assert.equal(store.wait(ROOM, r.id, "s2"), null);
    assert.equal(store.wait(OTHER, r.id, "s1"), null);
    assert.equal(store.wait(ROOM, "nope", "s1"), null);
    store.cancel(ROOM, r.id, "s1");
    assert.equal(await held?.answer, "gone", "the original wait was still the one held");
  });

  test("two clients sharing the session and request: the newer wait takes over, the older hears superseded once", async () => {
    const { store, asked } = setup();
    const r = asked("s1");
    const older = store.wait(ROOM, r.id, "s1");
    const newer = store.wait(ROOM, r.id, "s1");
    assert.equal(await older?.answer, "superseded");
    store.turnAway(ROOM, [r.id]);
    assert.equal(await newer?.answer, "turned_away");
  });

  test("cancel while the let-in commits is request_deciding, then the wait answers in", async () => {
    const { store, asked } = setup();
    const r = asked("s1");
    store.take(ROOM, r.id);
    const held = store.wait(ROOM, r.id, "s1");
    assert.equal(store.cancel(ROOM, r.id, "s1"), "deciding");
    store.settle(r.id, "in");
    assert.equal(await held?.answer, "in");
  });

  test("a cancel, a switch to With the password, or expiry during a let-in that then fails takes that ending", () => {
    for (const [what, ending] of [
      ["cancel", "cancelled"],
      ["close", "closed"],
      ["delete", "gone"],
      ["expire", "expired"],
    ] as const) {
      const { time, store, asked } = setup();
      const r = asked("s1");
      store.take(ROOM, r.id);
      if (what === "cancel") store.cancel(ROOM, r.id, "s1");
      if (what === "close") store.closeRoom(ROOM);
      if (what === "delete") store.dropRoom(ROOM);
      if (what === "expire") {
        time.advance(REQUEST_LIFE_MS + 1);
        store.sweep();
        assert.equal(store.get(r.id)?.state, "deciding", "nothing but its own let-in moves a deciding request");
      }
      store.settle(r.id, "failed");
      assert.equal(store.get(r.id)?.state, ending, what);
    }
  });

  test("a failed let-in with nothing recorded goes back to waiting with its place", () => {
    const { store, asked } = setup();
    const r = asked("s1");
    store.take(ROOM, r.id);
    store.markPending(r.id);
    store.settle(r.id, "failed");
    assert.equal(store.get(r.id)?.state, "waiting");
    assert.equal(store.get(r.id)?.pending, undefined);
    assert.deepEqual(store.list(ROOM).map((x) => x.id), [r.id]);
  });

  test("a failed let-in says why on the DM list for a minute, and the next let-in or an ending clears it (JBO2-02)", () => {
    const { time, store, asked } = setup();
    const r = asked("s1");
    store.take(ROOM, r.id);
    store.markPending(r.id);
    store.settle(r.id, "failed", "room_full");
    assert.equal(store.refusal(r), "room_full", "a let-in that failed after its 202 had no refusal to answer");
    store.take(ROOM, r.id);
    assert.equal(store.refusal(r), null, "a let-in running again says nothing old");
    store.settle(r.id, "failed", "busy");
    time.advance(REFUSAL_SHOWN_MS - 1);
    assert.equal(store.refusal(r), "busy");
    time.advance(1);
    assert.equal(store.refusal(r), null, "only for a while");
    store.take(ROOM, r.id);
    store.settle(r.id, "failed", "member_removed");
    store.turnAway(ROOM, [r.id]);
    assert.equal(store.refusal(r), null, "an ended request says nothing");
    assert.equal(r.refused, undefined);
  });

  test("the sweep clears a refusal past its minute and tells the DMs, so a list already on screen loses its words (JB-ASTRA-11)", async () => {
    const { time, store, asked } = setup();
    const signals: string[] = [];
    store.onChange((room) => signals.push(room));
    const r = asked("s1");
    const quiet = asked("s2", { room: OTHER });
    store.take(ROOM, r.id);
    store.settle(r.id, "failed", "room_full");
    await Promise.resolve();
    signals.length = 0;
    time.advance(REFUSAL_SHOWN_MS - 1);
    store.sweep();
    await Promise.resolve();
    assert.deepEqual(signals, [], "still shown, nothing to tell");
    assert.equal(r.refused?.code, "room_full");
    time.advance(1);
    store.sweep();
    await Promise.resolve();
    assert.equal(r.refused, undefined, "cleared, so no list drawn from here on says it");
    assert.deepEqual(signals, [ROOM], "only the room whose list changed");
    store.sweep();
    await Promise.resolve();
    assert.deepEqual(signals, [ROOM], "once");
    assert.equal(store.get(quiet.id)?.state, "waiting");
  });

  test("a request being let in stays on the DM list, marked, and a 202 marks it pending and tells the DMs (JBO1-01)", async () => {
    const { store, asked } = setup();
    const signals: string[] = [];
    store.onChange((room) => signals.push(room));
    const r = asked("s1");
    const other = asked("s2");
    store.take(ROOM, r.id);
    assert.deepEqual(store.list(ROOM).map((x) => [x.id, x.state, x.pending ?? false]), [[r.id, "deciding", false], [other.id, "waiting", false]]);
    await Promise.resolve();
    signals.length = 0;
    store.markPending(r.id);
    await Promise.resolve();
    assert.deepEqual(signals, [ROOM], "every DM device's row says it is still letting them in");
    assert.equal(store.list(ROOM)[0]?.pending, true);
    store.settle(r.id, "in");
    assert.deepEqual(store.list(ROOM).map((x) => x.id), [other.id], "an ending leaves the list");
  });

  test("two let-ins, or a let-in against a turn away: exactly one wins", () => {
    const { store, asked } = setup();
    const r = asked("s1");
    assert.ok(store.take(ROOM, r.id).ok);
    assert.deepEqual(store.take(ROOM, r.id), { ok: false, code: "request_answered" });
    assert.deepEqual(store.turnAway(ROOM, [r.id]), [], "a deciding request is skipped");
    const other = asked("s2");
    store.turnAway(ROOM, [other.id]);
    assert.deepEqual(store.take(ROOM, other.id), { ok: false, code: "request_answered" });
    assert.deepEqual(store.take(OTHER, r.id), { ok: false, code: "request_gone" }, "another room's id");
  });

  test("an unanswered request expires at 10 minutes, its ending is kept 2 minutes, then it is gone", async () => {
    const { time, store, asked } = setup();
    const r = asked("s1");
    time.advance(REQUEST_LIFE_MS);
    assert.equal(store.mine(ROOM, "s1")?.state, "expired", "LIFE, even before the sweep runs");
    assert.equal(await store.wait(ROOM, r.id, "s1")?.answer, "expired");
    time.advance(ENDED_KEEP_MS);
    store.sweep();
    assert.equal(store.get(r.id), undefined);
    assert.equal(store.mine(ROOM, "s1"), null);
  });

  test("a hold that did not save is retried dated to its turn away, stays owed while saving fails, and lapses with the hold (JR-SOL-03, JR-SOL-04)", async () => {
    const { time, store, asked } = setup();
    const r = asked("s1");
    const turnedAt = time.now;
    const [turned] = store.turnAway(ROOM, [r.id]);
    assert.ok(turned);
    // Its first write failed only after a slow wait: the hold is still the turn away's.
    time.advance(2_000);
    store.oweHold(turned);
    time.advance(60_000);
    const saved: number[] = [];
    let fail = true;
    const failures: unknown[] = [];
    const save = async (holds: OwedHold[]) => {
      if (fail) throw new Error("down");
      // However long the write waits for a connection, the date it saves is the turn away's.
      time.advance(5_000);
      saved.push(...holds.map((h) => h.at));
    };
    await store.retryHolds(save, (err) => failures.push(err));
    assert.equal(failures.length, 1);
    assert.equal(store.owedHolds, 1, "still owed");
    fail = false;
    time.advance(30_000);
    await store.retryHolds(save, (err) => failures.push(err));
    assert.deepEqual(saved, [turnedAt], "dated to the turn away, not to the save");
    assert.equal(store.owedHolds, 0);
    const late = asked("s2");
    const [again] = store.turnAway(ROOM, [late.id]);
    assert.ok(again);
    store.oweHold(again);
    time.advance(TURN_AWAY_HOLD_MS);
    await store.retryHolds(save, () => undefined);
    assert.deepEqual(saved, [turnedAt], "a hold past its 15 minutes holds nothing, so it is dropped unsaved");
    assert.equal(store.owedHolds, 0);
  });

  test("hold retries run one at a time, every owed hold in one save: a sweep while one runs gets that run, and saves no hold twice (JR-SOL-05, JBO3-01)", async () => {
    const { store, asked } = setup();
    for (const id of ["s1", "s2"]) {
      const [turned] = store.turnAway(ROOM, [asked(id).id]);
      assert.ok(turned);
      store.oweHold(turned);
    }
    let release!: () => void;
    const stalled = new Promise<void>((r) => (release = r));
    const saves: string[][] = [];
    const save = async (holds: OwedHold[]) => {
      saves.push(holds.map((h) => h.sessionId));
      await stalled;
    };
    const first = store.retryHolds(save, () => undefined);
    const second = store.retryHolds(save, () => undefined);
    assert.equal(second, first, "the same run");
    await Promise.resolve();
    assert.deepEqual(saves, [["s1", "s2"]], "one save for every hold owed, so a stalled database costs one wait");
    // Owed again while that save runs: a newer turn away's, which this save does not cover.
    const [again] = store.turnAway(ROOM, [asked("s4").id]);
    assert.ok(again);
    store.oweHold(again);
    release();
    await second;
    assert.equal(store.owedHolds, 1, "only the hold owed since");
    await store.retryHolds(save, () => undefined);
    assert.deepEqual(saves, [["s1", "s2"], ["s4"]], "a new run once that one ended");
    assert.equal(store.owedHolds, 0);
    await store.retryHolds(save, () => undefined);
    assert.equal(saves.length, 2, "nothing left owed, nothing saved");
    // That run had nothing to save. It ended too, so a hold owed since is saved by the next.
    const [later] = store.turnAway(ROOM, [asked("s3").id]);
    assert.ok(later);
    store.oweHold(later);
    await store.retryHolds(save, () => undefined);
    assert.deepEqual(saves, [["s1", "s2"], ["s4"], ["s3"]]);
  });

  test("a turned-away device is held 15 minutes in that room only", () => {
    const { time, store, ask, asked } = setup();
    const r = asked("s1");
    store.turnAway(ROOM, [r.id]);
    assert.equal(store.deviceCheck(ROOM, "s1")?.code, "asked_recently");
    assert.equal(store.deviceCheck(OTHER, "s1"), null);
    time.advance(TURN_AWAY_HOLD_MS);
    assert.equal(store.deviceCheck(ROOM, "s1"), null);
    assert.ok(store.admit(ask("s1"), { sessionId: "s1", name: "Quinn", color: "#3e8ef7" }).ok);
  });

  test("shutdown answers every held wait at once, and new ones answer waiting without holding", async () => {
    const { time, store, asked } = setup();
    const a = asked("s1");
    const held = store.wait(ROOM, a.id, "s1");
    store.close();
    assert.equal(await held?.answer, "waiting");
    assert.equal(await store.wait(ROOM, a.id, "s1")?.answer, "waiting");
    assert.equal(time.pending, 0, "no timer left");
  });

  test("the DMs are signalled once per room per turn, on asks, answers and endings", async () => {
    const { store, asked } = setup();
    const signals: string[] = [];
    store.onChange((room) => signals.push(room));
    const r = asked("s1");
    asked("s2", { room: OTHER });
    store.take(ROOM, r.id);
    await Promise.resolve();
    assert.deepEqual(signals.sort(), [ROOM, OTHER]);
  });

  test("a device getting in with no request here, or a member leaving flight, signals too: who can be let in as changed (JB-ASTRA-05)", async () => {
    const { store } = setup();
    const signals: string[] = [];
    store.onChange((room) => signals.push(room));
    store.gotIn(ROOM, "s9");
    await Promise.resolve();
    assert.deepEqual(signals, [ROOM]);
    store.changed(OTHER);
    store.changed(OTHER);
    await Promise.resolve();
    assert.deepEqual(signals, [ROOM, OTHER], "once per room per turn, as the store's own changes");
  });
});
