import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { playerLink } from "#shared/playerLink.ts";
import { captureLinkPassword, dropLinkPassword, linkState, offerLinkPassword, readJoinInput, subscribeLinkState } from "./playerLink.ts";

/** A stand-in for location and history.replaceState that records what the address bar would show. */
function browser(href: string) {
  const url = new URL(href, "https://vtt.example.com");
  const replaced: string[] = [];
  const location = { pathname: url.pathname, search: url.search, hash: url.hash };
  return { location, replaced, replace: (next: string) => void replaced.push(next) };
}

beforeEach(() => {
  const pending = linkState().pending;
  if (pending) dropLinkPassword(pending.seq);
});

describe("opening a player link", () => {
  test("takes the password out of the address bar and holds it for its room", () => {
    const b = browser(playerLink("K7QH2MXA", "owlbear-druid-wand"));
    const before = linkState().opened;
    let heldWhenReplaced: unknown = "unset";
    const found = captureLinkPassword(b.location, (url) => {
      heldWhenReplaced = linkState().pending;
      b.replaced.push(url);
    });
    assert.equal(found, true);
    assert.deepEqual(b.replaced, ["/r/K7QH-2MXA"]);
    assert.equal(heldWhenReplaced, null, "the address bar is cleaned before the password is offered");
    assert.deepEqual(linkState().pending, { roomId: "K7QH2MXA", password: "owlbear-druid-wand", seq: before + 1 });
    assert.equal(linkState().opened, before + 1);
  });

  test("keeps the query and any other fragment", () => {
    const b = browser("/r/k7qh2mxa?x=1#pw=a%20b&note=1");
    captureLinkPassword(b.location, b.replace);
    assert.deepEqual(b.replaced, ["/r/k7qh2mxa?x=1#note=1"]);
    assert.equal(linkState().pending?.password, "a b");
    assert.equal(linkState().pending?.roomId, "K7QH2MXA");
  });

  test("leaves the address bar alone when there is no password", () => {
    for (const href of ["/r/K7QH-2MXA", "/r/K7QH-2MXA#dm=q5pYb8lJcN0p6tDq3kXz9wR1sV2uF4hG7jK8mN0pQ2s", "/"]) {
      const b = browser(href);
      assert.equal(captureLinkPassword(b.location, b.replace), false);
      assert.deepEqual(b.replaced, []);
    }
    assert.equal(linkState().pending, null);
  });

  test("removes a password from a path that is not a room, then forgets it", () => {
    for (const href of ["/#pw=owlbear-druid-wand", "/r/nope#pw=owlbear-druid-wand"]) {
      const b = browser(href);
      assert.equal(captureLinkPassword(b.location, b.replace), true);
      assert.equal(b.replaced.length, 1);
      assert.doesNotMatch(b.replaced[0]!, /pw=/);
    }
    assert.equal(linkState().pending, null);
  });

  test("a cut-off link is held without a password, so the join page can say so", () => {
    const b = browser("/r/K7QH-2MXA#pw=owlbear%2");
    captureLinkPassword(b.location, b.replace);
    assert.deepEqual(b.replaced, ["/r/K7QH-2MXA"]);
    assert.equal(linkState().pending?.password, null);
  });
});

describe("the held password", () => {
  test("is dropped once its page takes it, and only by that link", () => {
    offerLinkPassword("K7QH2MXA", "first");
    const first = linkState().pending!;
    offerLinkPassword("K7QH2MXA", "second");
    const second = linkState().pending!;
    assert.equal(second.seq, first.seq + 1);
    dropLinkPassword(first.seq);
    assert.equal(linkState().pending?.password, "second");
    dropLinkPassword(second.seq);
    assert.equal(linkState().pending, null);
    dropLinkPassword(second.seq);
    assert.equal(linkState().opened, second.seq);
  });

  test("tells subscribers about each change", () => {
    let calls = 0;
    const stop = subscribeLinkState(() => calls++);
    offerLinkPassword("K7QH2MXA", "owlbear-druid-wand");
    dropLinkPassword(linkState().pending!.seq);
    stop();
    offerLinkPassword("K7QH2MXA", "unheard");
    assert.equal(calls, 2);
  });
});

describe("the Home page's join field", () => {
  test("takes a room ID or a join link", () => {
    assert.deepEqual(readJoinInput("k7qh-2mxa"), { roomId: "K7QH2MXA", fragment: null });
    assert.deepEqual(readJoinInput("https://vtt.example.com/r/K7QH-2MXA"), { roomId: "K7QH2MXA", fragment: null });
    assert.equal(readJoinInput("hello"), null);
  });

  test("brings a pasted player link's password along", () => {
    assert.deepEqual(readJoinInput(" https://vtt.example.com/r/K7QH-2MXA#pw=owlbear-druid-wand "), {
      roomId: "K7QH2MXA",
      fragment: { password: "owlbear-druid-wand", hash: "" },
    });
  });
});
