import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HAND_OFF_WAIT_MS, handFocusNow, handFocusOn, handFocusTo, pressedControl } from "./handFocus.ts";

/**
 * A page of named elements, one of them focused, where removing the
 * focused one leaves focus on the body as a browser does, and frames run
 * when the test says, each `ms` after the last.
 */
function page(names: string[], focused: string) {
  const body = { isConnected: true, name: "body" };
  const els = new Map(names.map((name) => [name, { name, isConnected: true, focus: () => (doc.activeElement = els.get(name)!) }]));
  const doc: { activeElement: { isConnected: boolean; name: string } | null; body: unknown } = { activeElement: els.get(focused) ?? body, body };
  let clock = 0;
  let queued: (() => void)[] = [];
  const env = { doc, schedule: (run: () => void) => void queued.push(run), now: () => clock };
  const frame = { name: "frame", isConnected: true };
  const scope = {
    isConnected: true,
    focus: () => (doc.activeElement = frame),
    querySelector: (selector: string) => (els.get(selector)?.isConnected ? els.get(selector)! : null),
  };
  return {
    doc,
    env,
    scope,
    remove(name: string) {
      const el = els.get(name)!;
      el.isConnected = false;
      if (doc.activeElement === el) doc.activeElement = body;
    },
    frame(ms = 16) {
      clock += ms;
      const now = queued;
      queued = [];
      for (const run of now) run();
    },
    active: () => doc.activeElement?.name ?? null,
  };
}

describe("focus hand-off from a control a press takes away (SFB-P-3)", () => {
  test("Revive gone with focus on it: focus goes to the first target there is", () => {
    const p = page(["revive", "hp", "vitals"], "revive");
    handFocusOn(p.scope, ["missing", "hp", "vitals"], p.env);
    p.remove("revive");
    p.frame();
    assert.equal(p.active(), "hp");
  });

  test(":scope hands focus to the scope itself, such as the token bar's frame", () => {
    const p = page(["revive"], "revive");
    handFocusOn(p.scope, ["missing", ":scope"], p.env);
    p.remove("revive");
    p.frame();
    assert.equal(p.active(), "frame");
  });

  test("a control that goes only with the server's answer, frames later, still hands focus on", () => {
    const p = page(["make", "settings"], "make");
    handFocusOn(p.scope, ["settings"], p.env);
    for (let i = 0; i < 20; i++) p.frame();
    assert.equal(p.active(), "make", "waiting for the answer");
    p.remove("make");
    p.frame();
    assert.equal(p.active(), "settings");
  });

  test("nothing moves when the control stays past the wait, when it never had focus, or when focus went elsewhere", () => {
    const kept = page(["revive", "hp"], "revive");
    handFocusOn(kept.scope, ["hp"], kept.env);
    kept.frame(HAND_OFF_WAIT_MS + 1);
    kept.remove("revive");
    kept.frame();
    assert.equal(kept.active(), "body", "a refusal kept it, and the hand-off gave up");
    const tapped = page(["revive", "hp"], "none");
    handFocusOn(tapped.scope, ["hp"], tapped.env);
    tapped.remove("revive");
    tapped.frame();
    assert.equal(tapped.active(), "body", "a tap that gave it no focus");
    const moved = page(["revive", "hp", "other"], "revive");
    handFocusOn(moved.scope, ["hp"], moved.env);
    moved.doc.activeElement = { isConnected: true, name: "other" };
    moved.frame();
    moved.remove("revive");
    moved.frame();
    assert.equal(moved.active(), "other");
  });

  test("a scope gone with the control hands focus nowhere", () => {
    const p = page(["revive", "hp"], "revive");
    handFocusOn({ ...p.scope, isConnected: false }, ["hp"], p.env);
    p.remove("revive");
    p.frame();
    assert.equal(p.active(), "body");
  });
});

describe("the hand-off's one step, for a caller that knows when the op behind the press settled", () => {
  test("an offline delete answered long after the frame-by-frame wait still hands focus on", () => {
    const p = page(["delete", "next"], "delete");
    const pressed = pressedControl(p.doc);
    assert.equal(handFocusNow(p.scope, pressed, ["own", "next"], p.doc), null, "nothing yet: the control is still there");
    p.frame(HAND_OFF_WAIT_MS * 6);
    p.remove("delete");
    assert.ok(handFocusNow(p.scope, pressed, ["own", "next"], p.doc));
    assert.equal(p.active(), "next");
  });

  test("a refusal that takes the control away but leaves its row hands focus to the row, the first target", () => {
    const p = page(["delete", "own", "next"], "delete");
    const pressed = pressedControl(p.doc);
    p.remove("delete");
    handFocusNow(p.scope, pressed, ["own", "next"], p.doc);
    assert.equal(p.active(), "own");
  });

  test("nothing moves while the control stays, when it never had focus, or when focus went elsewhere", () => {
    const kept = page(["delete", "next"], "delete");
    assert.equal(handFocusNow(kept.scope, pressedControl(kept.doc), ["next"], kept.doc), null);
    assert.equal(kept.active(), "delete");
    const tapped = page(["delete", "next"], "none");
    const none = pressedControl(tapped.doc);
    assert.equal(none, null, "a tap that gave it no focus has nothing to lose");
    tapped.remove("delete");
    assert.equal(handFocusNow(tapped.scope, none, ["next"], tapped.doc), null);
    assert.equal(tapped.active(), "body");
    const moved = page(["delete", "next", "other"], "delete");
    const pressed = pressedControl(moved.doc);
    moved.doc.activeElement = { isConnected: true, name: "other" };
    moved.remove("delete");
    assert.equal(handFocusNow(moved.scope, pressed, ["next"], moved.doc), null);
    assert.equal(moved.active(), "other");
  });
});

describe("the hand-off whose target is found once the control has gone (LP21-COMBAT-2)", () => {
  test("a list's last button gone with its list: focus goes to what find reads then, not before", () => {
    const p = page(["restore", "card"], "restore");
    let asked = 0;
    handFocusTo(() => {
      asked++;
      return p.scope.querySelector("card");
    }, p.env);
    p.frame();
    assert.equal(asked, 0, "read before the control went");
    p.remove("restore");
    p.frame();
    assert.equal(asked, 1);
    assert.equal(p.active(), "card");
  });

  test("nothing moves while the control stays past the wait, when it never had focus, when focus went elsewhere, or when nothing stayed", () => {
    const kept = page(["restore", "card"], "restore");
    handFocusTo(() => kept.scope.querySelector("card"), kept.env);
    kept.frame(HAND_OFF_WAIT_MS + 1);
    kept.remove("restore");
    kept.frame();
    assert.equal(kept.active(), "body");
    const tapped = page(["restore", "card"], "none");
    handFocusTo(() => tapped.scope.querySelector("card"), tapped.env);
    tapped.remove("restore");
    tapped.frame();
    assert.equal(tapped.active(), "body");
    const moved = page(["restore", "card", "other"], "restore");
    handFocusTo(() => moved.scope.querySelector("card"), moved.env);
    moved.doc.activeElement = { isConnected: true, name: "other" };
    moved.frame();
    moved.remove("restore");
    moved.frame();
    assert.equal(moved.active(), "other");
    const gone = page(["restore"], "restore");
    handFocusTo(() => null, gone.env);
    gone.remove("restore");
    gone.frame();
    assert.equal(gone.active(), "body");
  });
});
