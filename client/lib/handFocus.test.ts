import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HAND_OFF_WAIT_MS, handFocusOn } from "./handFocus.ts";

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
