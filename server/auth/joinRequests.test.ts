import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ADMISSION_DEADLINE_MS,
  ENDED_KEEP_MS,
  JoinRequests,
  REQUEST_LIFE_MS,
  TURN_AWAY_HOLD_MS,
  WAIT_HOLD_MS,
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
    store.markPending(r.id, "m1");
    store.settle(r.id, "failed");
    assert.equal(store.get(r.id)?.state, "waiting");
    assert.equal(store.get(r.id)?.pending, undefined);
    assert.deepEqual(store.list(ROOM).map((x) => x.id), [r.id]);
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
});
