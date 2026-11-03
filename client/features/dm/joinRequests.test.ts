import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FakeClock } from "../../state/testing.ts";
import {
  answerErrorText,
  askedText,
  carryOnNote,
  carryOnPlayers,
  createJoinRequestsLoader,
  createJoinToaster,
  dmBadgeLabel,
  JOIN_FLOOD_TEXT,
  joinToastText,
  nextAgeTickMs,
  ownAnswerOver,
  panelsButtonLabel,
  rosterKey,
  rowBusy,
  rowBusyText,
  turnAwayAllErrorText,
  typedNameMatch,
  waitingRows,
  type JoinRequestList,
  type JoinRequestRow,
  type OwnAnswer,
  type RowBusy,
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
      "Their device becomes Quinn, with Quinn's characters, tokens and whispers. Pick Quinn only if you know it is them.",
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

  test("a row being let in is busy from the list on every DM device, and this device's own answer holds it busy", () => {
    const waiting = row("a", "Quinn");
    const deciding = { ...waiting, deciding: true as const };
    const pending = { ...deciding, pending: true as const };
    assert.equal(rowBusy(null, waiting), null);
    assert.equal(rowBusy(null, deciding), "letting", "a co-DM's let-in");
    assert.equal(rowBusy(null, pending), "still", "a co-DM's let-in that answered 202");
    assert.equal(rowBusy("letting", waiting), "letting", "this device's tap, before the list shows it");
    assert.equal(rowBusy("still", deciding), "still", "this device's 202, before the list marks it pending");
    assert.equal(rowBusy("turning", waiting), "turning");
    assert.deepEqual(waitingRows([waiting, { ...row("b", "Pat"), deciding: true }]).map((r) => r.id), ["a"], "only waiting rows count, toast or are turned away");
  });

  test("a 202 and the list that settles it, in either order, never leave the row stuck on Still letting (JB-ASTRA-08)", () => {
    // RequestRow's own answer, step by step: a tap, lists arriving, the HTTP answer, and its effect checking after each.
    type Step = { list: "deciding" | "pending" | "waiting" } | { answer: "202" | "final" };
    const play = (steps: Step[]): RowBusy | null => {
      let latest: { deciding: boolean } = { deciding: false };
      let own: OwnAnswer<object> | null = { busy: "letting", sent: latest, heard: "none", finalAt: null };
      for (const step of steps) {
        if ("list" in step) latest = { deciding: step.list !== "waiting" };
        else if (own) own = step.answer === "202" ? { ...own, busy: "still", heard: "pending" } : { ...own, heard: "final", finalAt: latest };
        if (own && ownAnswerOver(own, latest, latest.deciding)) own = null;
      }
      return own?.busy ?? null;
    };
    assert.equal(play([{ list: "deciding" }, { answer: "202" }, { list: "pending" }]), "still", "the let-in is still running");
    assert.equal(play([{ list: "deciding" }, { answer: "202" }, { list: "pending" }, { list: "waiting" }]), null, "202 first, then the list that settles it");
    assert.equal(play([{ list: "deciding" }, { list: "pending" }, { list: "waiting" }, { answer: "202" }]), null, "the settling list first, then the 202");
    assert.equal(play([{ answer: "202" }]), "still", "no newer list yet: still letting in");
    assert.equal(play([{ list: "deciding" }, { answer: "final" }]), "letting", "let in: busy until the next list, which drops the row");
    assert.equal(play([{ list: "deciding" }, { answer: "final" }, { list: "waiting" }]), null);
    assert.equal(play([{ list: "waiting" }]), "letting", "no answer yet: nothing but a refusal ends this device's own answer");
  });

  test("the carry-on list follows the roster: a join, a rename, a removal and a DM upgrade each fetch it again, and names and kinds show at once (JB-ASTRA-05)", () => {
    const pat = { id: "p1", name: "Pat", color: "#30a46c", kind: "player" as const };
    const sam = { id: "p2", name: "Sam", color: "#e5484d", kind: "player" as const };
    const dana = { id: "d1", name: "Dana", color: "#ffc53d", kind: "dm" as const };
    const room = { p1: pat, p2: sam, d1: dana };
    const key = rosterKey(room);
    assert.equal(rosterKey({ ...room }), key, "the same roster is no change");
    assert.equal(rosterKey({ d1: dana, p2: sam, p1: pat }), key, "order is no change");
    const changes = {
      join: { ...room, p3: { id: "p3", name: "Wren", color: "#fff", kind: "player" as const } },
      rename: { ...room, p1: { ...pat, name: "Patricia" } },
      removal: { p2: sam, d1: dana },
      upgrade: { ...room, p2: { ...sam, kind: "dm" as const } },
    };
    for (const [what, members] of Object.entries(changes)) assert.notEqual(rosterKey(members), key, `${what} fetches the list again`);

    const listed = [{ id: "p1", name: "Pat", color: "#30a46c" }, { id: "p2", name: "Sam", color: "#e5484d" }];
    assert.deepEqual(carryOnPlayers(listed, changes.rename).map((p) => p.name), ["Patricia", "Sam"], "the name the room knows now");
    assert.deepEqual(carryOnPlayers(listed, changes.removal).map((p) => p.id), ["p2"], "a removed player is never offered");
    assert.deepEqual(carryOnPlayers(listed, changes.upgrade).map((p) => p.id), ["p1"], "nor one who is a DM now");
    assert.deepEqual(carryOnPlayers(listed, undefined), listed, "before the snapshot, the server's list");
  });

  test("turn away all's refusals never name a person, whatever the server says (JBO1-11, ymzqvvnx)", () => {
    for (const code of ["request_gone", "request_answered", "already_in", "room_full", "member_removed", "not_a_player", "weird", undefined]) {
      assert.equal(turnAwayAllErrorText(code), "Something went wrong. Try again.", String(code));
    }
    assert.equal(turnAwayAllErrorText("busy"), "The server is busy. Try again in a moment.");
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

  test("a request whose let-in fails and comes back to waiting never toasts again (JBO1-01)", () => {
    const t = toasterSetup();
    t.toaster.update(list([]), false);
    t.toaster.update(list([row("a", "Quinn")]), false);
    t.clock.advance(30_000);
    t.toaster.update(list([{ ...row("a", "Quinn"), deciding: true }]), false);
    t.clock.advance(30_000);
    // The room was full: the request waits again, with the same id.
    t.toaster.update(list([row("a", "Quinn")]), false);
    t.clock.advance(30_000);
    assert.deepEqual(t.shown, ["Quinn asks to join."]);
  });

  test("a request being let in when a DM device opens the room is no news", () => {
    const t = toasterSetup();
    t.toaster.update(list([{ ...row("a", "Quinn"), deciding: true, pending: true }]), false);
    t.clock.advance(60_000);
    assert.deepEqual(t.shown, []);
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

  test("the many-asks notice waits out the 20 s gap after an ordinary toast, and still comes once (JB-ASTRA-07)", () => {
    const t = toasterSetup();
    t.toaster.update(list([]), false);
    t.toaster.update(list([row("a", "Quinn")]), false);
    t.clock.advance(5_000);
    // The room passes its threshold 5 s after Quinn's toast.
    t.toaster.update(list([row("a", "Quinn"), row("b", "Pat", 5)], { challenged: true }), false);
    assert.deepEqual(t.shown, ["Quinn asks to join."], "held for the gap");
    t.clock.advance(14_999);
    assert.equal(t.shown.length, 1);
    t.clock.advance(1);
    assert.deepEqual(t.shown, ["Quinn asks to join.", JOIN_FLOOD_TEXT]);
    t.toaster.update(list([row("a", "Quinn"), row("b", "Pat", 5), row("c", "Sam", 30)], { challenged: true }), false);
    t.clock.advance(60_000);
    assert.deepEqual(t.shown, ["Quinn asks to join.", JOIN_FLOOD_TEXT], "once per challenge");
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
