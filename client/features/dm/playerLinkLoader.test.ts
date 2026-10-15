import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { playerLink } from "#shared/playerLink.ts";
import { createPlayerLinkLoader, type LinkState } from "./playerLinkLoader.ts";

/** A loader whose requests the test answers by hand, in any order. */
function setup() {
  const requests: { resolve(link: string | null): void; reject(err: unknown): void }[] = [];
  const states: LinkState[] = [];
  const loader = createPlayerLinkLoader({
    fetch: () => new Promise<string | null>((resolve, reject) => requests.push({ resolve, reject })),
    describe: () => "Something went wrong. Try again.",
    onChange: (s) => states.push(s),
  });
  /** Answers one request and lets its continuation run. */
  const answer = async (i: number, password: string | null) => {
    requests[i]!.resolve(password === null ? null : playerLink("K7QH2MXA", password));
    await new Promise((r) => setTimeout(r, 0));
  };
  return { loader, requests, states, answer };
}

describe("the player link section's requests", () => {
  test("an answer from before an access signal is dropped, and the signal that lands mid-load fetches again", async () => {
    const t = setup();
    void t.loader.show();
    assert.deepEqual(t.loader.state, { kind: "loading" });
    // Another DM device changes the password while the first request is out.
    t.loader.accessChanged();
    assert.equal(t.requests.length, 2);
    await t.answer(0, "old-owlbear-wand");
    assert.deepEqual(t.loader.state, { kind: "loading" }, "the old password never shows");
    await t.answer(1, "new-druid-staff");
    assert.deepEqual(t.loader.state, { kind: "shown", password: "new-druid-staff" });
    assert.equal(t.states.some((s) => s.kind === "shown" && s.password === "old-owlbear-wand"), false);
  });

  test("the older answer is dropped even when it lands last", async () => {
    const t = setup();
    void t.loader.show();
    t.loader.accessChanged();
    await t.answer(1, "new-druid-staff");
    await t.answer(0, "old-owlbear-wand");
    assert.deepEqual(t.loader.state, { kind: "shown", password: "new-druid-staff" });
  });

  test("a signal fetches again while a link is on screen, and leaves a hidden link hidden", async () => {
    const t = setup();
    t.loader.accessChanged();
    assert.equal(t.requests.length, 0);
    void t.loader.show();
    await t.answer(0, "old-owlbear-wand");
    t.loader.accessChanged();
    assert.equal(t.requests.length, 2);
    await t.answer(1, null);
    assert.deepEqual(t.loader.state, { kind: "none" });
    t.loader.accessChanged();
    await t.answer(2, "new-druid-staff");
    assert.deepEqual(t.loader.state, { kind: "shown", password: "new-druid-staff" });
    t.loader.hide();
    t.loader.accessChanged();
    assert.equal(t.requests.length, 3);
  });

  test("hiding drops an answer still on its way, and a failure says so", async () => {
    const t = setup();
    void t.loader.show();
    t.loader.hide();
    await t.answer(0, "old-owlbear-wand");
    assert.deepEqual(t.loader.state, { kind: "hidden" });
    void t.loader.show();
    t.requests[1]!.reject(new Error("offline"));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(t.loader.state, { kind: "error", message: "Something went wrong. Try again." });
  });
});
