import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FakeClock } from "../../state/testing.ts";
import {
  answerErrorText,
  askedText,
  carryOnNote,
  createJoinRequestsLoader,
  createJoinToaster,
  dmBadgeLabel,
  JOIN_FLOOD_TEXT,
  joinToastText,
  nextAgeTickMs,
  panelsButtonLabel,
  rowBusyText,
  typedNameMatch,
  type JoinRequestList,
  type JoinRequestRow,
} from "./joinRequests.ts";

const T0 = Date.parse("2026-11-02T12:00:00.000Z");
const row = (id: string, name: string, secondsAfter = 0): JoinRequestRow => ({
  id,
  name,
  color: "#30a46c",
  askedAt: new Date(T0 + secondsAfter * 1000).toISOString(),
});
const list = (requests: JoinRequestRow[], over: Partial<JoinRequestList> = {}): JoinRequestList => ({ mode: "ask", challenged: false, requests, players: [], ...over });

describe("ages and words", () => {
  test("asked just now, then minutes", () => {
    const at = new Date(T0).toISOString();
    assert.equal(askedText(at, T0), "Asked just now");
    assert.equal(askedText(at, T0 + 59_999), "Asked just now");
    assert.equal(askedText(at, T0 + 60_000), "Asked 1 min ago");
    assert.equal(askedText(at, T0 + 3 * 60_000 + 5_000), "Asked 3 min ago");
  });

  test("a device clock behind the server's never reads as a negative age", () => {
    assert.equal(askedText(new Date(T0 + 90_000).toISOString(), T0), "Asked just now");
    assert.equal(askedText("garbage", T0), "Asked just now");
  });

  test("the age ticks at the next whole minute of the nearest request", () => {
    assert.equal(nextAgeTickMs([], T0), null);
    assert.equal(nextAgeTickMs([row("a", "Quinn")], T0 + 20_000), 40_000);
    assert.equal(nextAgeTickMs([row("a", "Quinn"), row("b", "Pat", 50)], T0 + 55_000), 5_000);
  });

  test("badge words keep the upload first and leave out what is at zero", () => {
    assert.equal(dmBadgeLabel(0, 2), "2 join requests");
    assert.equal(dmBadgeLabel(0, 1), "1 join request");
    assert.equal(dmBadgeLabel(1, 2), "1 upload waiting, 2 join requests");
    assert.equal(dmBadgeLabel(1, 0), "1 upload waiting");
    assert.equal(dmBadgeLabel(0, 0), "");
    assert.equal(panelsButtonLabel(2, 1, 2), "2 unread, 1 upload waiting, 2 join requests");
    assert.equal(panelsButtonLabel(0, 0, 3), "3 join requests");
    assert.equal(panelsButtonLabel(4, 0, 0), "4 unread");
  });

  test("the carry-on note names what the pick hands over, online status and a name match", () => {
    const quinn = { name: "Quinn" };
    assert.equal(
      carryOnNote(quinn, false, false),
      "This device will be Quinn: Quinn's characters, tokens and whispers. Only pick Quinn if you know it is them.",
    );
    assert.match(carryOnNote(quinn, true, false), / Quinn is online now\.$/);
    assert.match(carryOnNote(quinn, false, true), / The name they typed matches Quinn\.$/);
    assert.match(carryOnNote(quinn, true, true), /Quinn is online now\. The name they typed matches Quinn\.$/);
  });

  test("a typed name matches after NFKC and case folding, and look-alikes only ever hint", () => {
    const players = [{ id: "p1", name: "Quinn", color: "#fff" }, { id: "p2", name: "Straße", color: "#fff" }];
    assert.equal(typedNameMatch("  QUINN ", players)?.id, "p1");
    // Full-width letters fold to ASCII under NFKC.
    assert.equal(typedNameMatch("Ｑｕｉｎｎ", players)?.id, "p1");
    assert.equal(typedNameMatch("STRASSE", players)?.id, "p2");
    // Cyrillic Qu-look-alikes are different letters: no match, which is why a match is only a hint.
    assert.equal(typedNameMatch("Quіnn", players), null);
    assert.equal(typedNameMatch("", players), null);
    assert.equal(typedNameMatch("   ", [{ id: "x", name: " ", color: "#fff" }]), null);
  });

  test("row busy words and the refusals", () => {
    assert.equal(rowBusyText("letting", "Quinn"), "Letting in…");
    assert.equal(rowBusyText("turning", "Quinn"), "Turning away…");
    assert.equal(rowBusyText("still", "Quinn"), "Still letting Quinn in…");
    assert.equal(answerErrorText("request_gone", "Quinn"), "Quinn is no longer asking.");
    assert.equal(answerErrorText("request_answered", "Quinn"), "Another DM already answered.");
    assert.equal(answerErrorText("already_in", "Quinn"), "Quinn is in the room already.");
    assert.equal(answerErrorText("room_full", "Quinn"), "The room is full: it holds 50 members. Remove a member first.");
    assert.equal(answerErrorText("member_removed", "Quinn"), "That player was just removed. Let them in as someone new.");
    assert.equal(answerErrorText("busy", "Quinn"), "The server is busy. Try again in a moment.");
    assert.equal(answerErrorText("weird", "Quinn"), "Something went wrong. Try again.");
    assert.equal(answerErrorText(undefined, "Quinn"), "Something went wrong. Try again.");
  });

  test("toast words name the newest and count the rest", () => {
    assert.equal(joinToastText([row("a", "Quinn")], false), "Quinn asks to join.");
    assert.equal(joinToastText([row("a", "Quinn")], true), "Quinn is waiting to join.");
    assert.equal(joinToastText([row("a", "Quinn"), row("b", "Pat", 30), row("c", "Sam", 10)], false), "Pat and 2 more ask to join.");
    assert.equal(joinToastText([row("a", "Quinn"), row("b", "Pat", 30)], true), "Pat and 1 more are waiting to join.");
  });
});

function toasterSetup() {
  const clock = new FakeClock();
  clock.t = T0;
  const shown: string[] = [];
  const toaster = createJoinToaster({ clock, show: (t) => shown.push(t) });
  return { clock, shown, toaster };
}

describe("the join toast", () => {
  test("a request toasts once, by id, across fetches and reconnects", () => {
    const t = toasterSetup();
    t.toaster.update(list([]), false);
    t.toaster.update(list([row("a", "Quinn")]), false);
    t.toaster.update(list([row("a", "Quinn")]), false);
    t.clock.advance(60_000);
    t.toaster.update(list([row("a", "Quinn")]), false);
    assert.deepEqual(t.shown, ["Quinn asks to join."]);
  });

  test("a device that opens with requests waiting says so once", () => {
    const t = toasterSetup();
    t.toaster.update(list([row("a", "Quinn")]), false);
    t.clock.advance(25_000);
    t.toaster.update(list([row("a", "Quinn")]), false);
    assert.deepEqual(t.shown, ["Quinn is waiting to join."]);
    t.clock.advance(25_000);
    t.toaster.update(list([row("a", "Quinn"), row("b", "Pat", 60)]), false);
    assert.deepEqual(t.shown, ["Quinn is waiting to join.", "Pat asks to join."], "only the first is the opening one");
  });

  test("a second request inside 20 s waits for the gap and then names the newest with the count", () => {
    const t = toasterSetup();
    t.toaster.update(list([]), false);
    t.toaster.update(list([row("a", "Quinn")]), false);
    t.clock.advance(5_000);
    t.toaster.update(list([row("a", "Quinn"), row("b", "Pat", 5)]), false);
    t.clock.advance(3_000);
    t.toaster.update(list([row("a", "Quinn"), row("b", "Pat", 5), row("c", "Sam", 8)]), false);
    assert.deepEqual(t.shown, ["Quinn asks to join."], "held back");
    t.clock.advance(11_999);
    assert.equal(t.shown.length, 1);
    t.clock.advance(1);
    assert.deepEqual(t.shown, ["Quinn asks to join.", "Sam and 1 more ask to join."]);
  });

  test("a held toast is dropped when its requests are answered before the gap ends", () => {
    const t = toasterSetup();
    t.toaster.update(list([]), false);
    t.toaster.update(list([row("a", "Quinn")]), false);
    t.clock.advance(5_000);
    t.toaster.update(list([row("a", "Quinn"), row("b", "Pat", 5)]), false);
    t.toaster.update(list([row("a", "Quinn")]), false);
    t.clock.advance(60_000);
    assert.equal(t.shown.length, 1);
  });

  test("past the ask threshold requests stop toasting and one notice says why", () => {
    const t = toasterSetup();
    t.toaster.update(list([]), false);
    t.toaster.update(list([row("a", "Quinn")], { challenged: true }), false);
    t.clock.advance(30_000);
    t.toaster.update(list([row("a", "Quinn"), row("b", "Pat", 30), row("c", "Sam", 31)], { challenged: true }), false);
    t.clock.advance(30_000);
    assert.deepEqual(t.shown, [JOIN_FLOOD_TEXT]);
    // The threshold lifts, and the next ask toasts as ever.
    t.toaster.update(list([], { challenged: false }), false);
    t.toaster.update(list([row("d", "Robin", 120)]), false);
    assert.deepEqual(t.shown, [JOIN_FLOOD_TEXT, "Robin asks to join."]);
  });

  test("View as a player holds new toasts until the DM leaves, and then they show", () => {
    const t = toasterSetup();
    t.toaster.update(list([]), false);
    t.toaster.update(list([row("a", "Quinn")]), true);
    t.clock.advance(60_000);
    assert.deepEqual(t.shown, []);
    t.toaster.update(list([row("a", "Quinn")]), false);
    assert.deepEqual(t.shown, ["Quinn asks to join."]);
  });

  test("stop cancels a held toast", () => {
    const t = toasterSetup();
    t.toaster.update(list([]), false);
    t.toaster.update(list([row("a", "Quinn")]), false);
    t.clock.advance(1_000);
    t.toaster.update(list([row("a", "Quinn"), row("b", "Pat")]), false);
    t.toaster.stop();
    t.clock.advance(60_000);
    assert.equal(t.shown.length, 1);
    assert.equal(t.clock.pendingTimers, 0);
  });
});

function loaderSetup() {
  const clock = new FakeClock();
  const calls: { resolve(l: JoinRequestList): void; reject(e: unknown): void }[] = [];
  const loader = createJoinRequestsLoader({
    clock,
    fetch: () => new Promise<JoinRequestList>((resolve, reject) => calls.push({ resolve, reject })),
    describe: () => "Something went wrong. Try again.",
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { clock, calls, loader, settle };
}

describe("the list's fetches", () => {
  test("only the newest answer shows, however the answers are ordered", async () => {
    const t = loaderSetup();
    t.loader.refresh();
    t.loader.refresh();
    t.calls[1]!.resolve(list([row("b", "Pat")]));
    await t.settle();
    t.calls[0]!.resolve(list([row("a", "Quinn")]));
    await t.settle();
    assert.equal(t.loader.state.kind === "shown" && t.loader.state.list.requests[0]?.id, "b");
  });

  test("a failed fetch tries again after 1, 2, 5, 10, then every 30 seconds, until one answers", async () => {
    const t = loaderSetup();
    t.loader.refresh();
    const waits = [1_000, 2_000, 5_000, 10_000, 30_000, 30_000];
    for (const [i, wait] of waits.entries()) {
      t.calls[i]!.reject(new Error("offline"));
      await t.settle();
      assert.equal(t.loader.state.kind, "error");
      t.clock.advance(wait - 1);
      assert.equal(t.calls.length, i + 1, `not before ${wait} ms`);
      t.clock.advance(1);
      assert.equal(t.calls.length, i + 2);
    }
    t.calls[waits.length]!.resolve(list([row("a", "Quinn")]));
    await t.settle();
    assert.equal(t.loader.state.kind, "shown");
    assert.equal(t.clock.pendingTimers, 0, "no retry left once an answer lands");
  });

  test("a section already showing keeps its rows and says it is stale", async () => {
    const t = loaderSetup();
    t.loader.refresh();
    t.calls[0]!.resolve(list([row("a", "Quinn")]));
    await t.settle();
    t.loader.refresh();
    t.calls[1]!.reject(new Error("offline"));
    await t.settle();
    assert.equal(t.loader.state.kind, "shown");
    assert.equal(t.loader.state.kind === "shown" && t.loader.state.stale, true);
    assert.equal(t.loader.state.kind === "shown" && t.loader.state.list.requests.length, 1);
    t.clock.advance(1_000);
    t.calls[2]!.resolve(list([]));
    await t.settle();
    assert.equal(t.loader.state.kind === "shown" && t.loader.state.stale, false);
  });

  test("a newer signal drops the retry wait and starts a fresh fetch with the back-off reset", async () => {
    const t = loaderSetup();
    t.loader.refresh();
    t.calls[0]!.reject(new Error("x"));
    await t.settle();
    t.clock.advance(1_000);
    t.calls[1]!.reject(new Error("x"));
    await t.settle();
    // Next wait would be 5 s. A signal starts over instead.
    t.loader.refresh();
    assert.equal(t.calls.length, 3);
    t.calls[2]!.reject(new Error("x"));
    await t.settle();
    t.clock.advance(1_000);
    assert.equal(t.calls.length, 4, "back to 1 s after a fresh signal");
  });

  test("an answer after stop changes nothing and leaves no timer", async () => {
    const t = loaderSetup();
    t.loader.refresh();
    t.loader.stop();
    t.calls[0]!.reject(new Error("x"));
    await t.settle();
    assert.equal(t.clock.pendingTimers, 0);
    assert.equal(t.loader.state.kind, "loading");
  });
});
