import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { askView, CLOSED_POLL_MS, joinCards, startClosedPoll, type ClosedPollEnv } from "./joinCards.ts";
import { LETTING_IN, waitingLine } from "./askToJoin.ts";

const cards = (over: Partial<Parameters<typeof joinCards>[0]>) => joinCards({ mode: "ask", picking: false, view: "password", looked: true, linked: false, ...over });

describe("the join page's cards", () => {
  test("a switch to Only by asking while Who are you? is open shows the ask card (JB-ASTRA-02)", () => {
    assert.equal(cards({ picking: true }), "pick");
    assert.equal(cards({ mode: "password", picking: true, looked: false }), "pick");
    assert.equal(cards({ mode: "ask_only", picking: true }), "ask_only");
  });

  test("in both asking modes nothing but Loading shows until the device's own request is looked up (JBO1-09)", () => {
    assert.equal(cards({ looked: false }), "loading");
    assert.equal(cards({ mode: "ask_only", looked: false }), "loading");
    assert.equal(cards({ mode: "ask_only", looked: false, linked: true }), "loading", "a link sends nothing in Only by asking");
    assert.equal(cards({ mode: "password", looked: false }), "password", "With the password looks nothing up");
    assert.equal(cards({ looked: false, linked: true }), "password", "a player link joins at once in With the password, or by asking");
  });

  test("once looked up, each mode shows its cards", () => {
    assert.equal(cards({}), "password");
    assert.equal(cards({ view: "ask" }), "ask");
    assert.equal(cards({ mode: "ask_only" }), "ask_only");
    assert.equal(cards({ mode: "password", view: "ask" }), "password");
  });

  test("a request found on load shows its card in the same render, until Back leaves it", () => {
    assert.equal(askView({ tapped: false, found: true, spent: false, linked: false }), "ask");
    assert.equal(askView({ tapped: false, found: true, spent: true, linked: false }), "password", "Back spends it");
    assert.equal(askView({ tapped: true, found: true, spent: true, linked: false }), "ask", "Ask to join after Back");
    assert.equal(askView({ tapped: false, found: true, spent: false, linked: true }), "password", "a player link joins instead");
    assert.equal(askView({ tapped: false, found: false, spent: false, linked: false }), "password");
  });
});

describe("the waiting card's status line", () => {
  test("the spinner says the sentence, or the let-in line while the DM decides", () => {
    assert.equal(waitingLine("Rowan"), "You asked to join as Rowan.");
    assert.equal(LETTING_IN, "The DM is letting you in…");
  });
});

describe("the closed card's poll (LP30FIX-S-4)", () => {
  function fake(visibility: string) {
    const listeners = new Map<string, Set<() => void>>();
    const target = (prefix: string) => ({
      addEventListener: (type: string, fn: () => void) => void (listeners.get(prefix + type) ?? listeners.set(prefix + type, new Set()).get(prefix + type)!).add(fn),
      removeEventListener: (type: string, fn: () => void) => void listeners.get(prefix + type)?.delete(fn),
    });
    const page = { visibilityState: visibility, ...target("page:") };
    const env: ClosedPollEnv = { page, win: target("win:") };
    const fire = (key: string) => listeners.get(key)?.forEach((fn) => fn());
    const count = () => [...listeners.values()].reduce((n, set) => n + set.size, 0);
    return { env, page, fire, count };
  }

  test("a hidden page reads nothing, a visible one reads on the timer, focus and coming back", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const f = fake("hidden");
    let reads = 0;
    const stop = startClosedPoll(() => reads++, f.env);
    t.mock.timers.tick(CLOSED_POLL_MS * 2);
    f.fire("win:focus");
    f.fire("page:visibilitychange");
    assert.equal(reads, 0);
    f.page.visibilityState = "visible";
    t.mock.timers.tick(CLOSED_POLL_MS);
    f.fire("win:focus");
    f.fire("page:visibilitychange");
    assert.equal(reads, 3);
    stop();
  });

  test("once the card is gone no listener or timer is left", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const f = fake("visible");
    let reads = 0;
    const stop = startClosedPoll(() => reads++, f.env);
    assert.equal(f.count(), 2);
    stop();
    assert.equal(f.count(), 0);
    t.mock.timers.tick(CLOSED_POLL_MS * 3);
    assert.equal(reads, 0);
  });
});
