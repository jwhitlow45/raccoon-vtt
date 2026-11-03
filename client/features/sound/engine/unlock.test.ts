import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createSoundUnlock, mixerSupported, POOL_SIZE, SILENCE_URL, watchAudio, type PoolElement } from "./context.ts";

/*
 * The room sound's unlock on lane audiounlock's helper (lib/activation.ts,
 * docs/design/design-v1-music.md 5.5 and 12): the pool's attempt answers
 * false and plays nothing with Room sound off, answers true only once every
 * play resolved, a blessing in flight is the one a second call gets, the
 * pool listens again when the context or the audio session leaves
 * `running` or `active`, and Play here's own call in its click blesses.
 */

type Fake = PoolElement & { plays: number; settle(ok: boolean): void };

function element(): Fake {
  let pending: { resolve(): void; reject(e: unknown): void } | null = null;
  const el: Fake = {
    src: "",
    muted: true,
    plays: 0,
    play() {
      el.plays++;
      return new Promise<void>((resolve, reject) => {
        pending = { resolve, reject };
      });
    },
    pause() {},
    settle(ok) {
      if (ok) pending?.resolve();
      else pending?.reject(new DOMException("not allowed", "NotAllowedError"));
      pending = null;
    },
  };
  return el;
}

function context() {
  const target = new EventTarget();
  const ctx = {
    state: "suspended",
    resumes: 0,
    resume() {
      ctx.resumes++;
      return Promise.resolve();
    },
    addEventListener: (type: "statechange", fn: () => void) => target.addEventListener(type, fn),
    removeEventListener: (type: "statechange", fn: () => void) => target.removeEventListener(type, fn),
    change(state: string) {
      ctx.state = state;
      target.dispatchEvent(new Event("statechange"));
    },
  };
  return ctx;
}

function harness() {
  const target = new EventTarget();
  const els: Fake[] = [];
  const ctx = context();
  let made = 0;
  const unlock = createSoundUnlock({
    makeContext: () => {
      made++;
      return ctx;
    },
    makeElement: () => {
      const el = element();
      els.push(el);
      return el;
    },
    target,
  });
  const tap = () => target.dispatchEvent(Object.assign(new Event("pointerup"), { pointerType: "touch" }));
  return { target, els, ctx, unlock, tap, made: () => made };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("the room sound's unlock", () => {
  test("with Room sound off a tap touches nothing: no element plays and no context is made", () => {
    const h = harness();
    h.unlock.arm(() => false);
    h.tap();
    assert.equal(h.els.length, 0, "the pool is not even made");
    assert.equal(h.made(), 0);
  });

  test("with Room sound on a tap plays silence on every element inside the gesture, and answers true only once every play resolved", async () => {
    const h = harness();
    h.unlock.arm(() => true);
    h.tap();
    assert.equal(h.els.length, POOL_SIZE);
    for (const el of h.els) {
      assert.equal(el.plays, 1, "played synchronously in the tap");
      assert.equal(el.src, SILENCE_URL);
    }
    assert.equal(h.ctx.resumes, 1, "the context resumed in the same tap");
    // All but one resolve: still listening.
    for (const el of h.els.slice(1)) el.settle(true);
    await flush();
    assert.equal(h.unlock.blessed(), false);
    h.els[0]!.settle(true);
    await flush();
    assert.equal(h.unlock.blessed(), true);
    h.tap();
    assert.ok(h.els.every((el) => el.plays === 1), "once blessed it stops listening");
  });

  test("a refused play keeps it listening, and the next tap blesses again", async () => {
    const h = harness();
    h.unlock.arm(() => true);
    h.tap();
    h.els[3]!.settle(false);
    for (const el of h.els) el.settle(true);
    await flush();
    assert.equal(h.unlock.blessed(), false);
    h.tap();
    assert.ok(h.els.every((el) => el.plays === 2));
  });

  test("a call while a blessing is in flight returns it and plays nothing again", async () => {
    const h = harness();
    const first = h.unlock.blessPool();
    const second = h.unlock.blessPool();
    assert.equal(first, second);
    assert.ok(h.els.every((el) => el.plays === 1));
    for (const el of h.els) el.settle(true);
    assert.equal(await first, true);
  });

  test("Play here's own call in its click blesses the pool there, whatever the listeners did before", async () => {
    const h = harness();
    let on = false;
    h.unlock.arm(() => on);
    // The window's capture listeners run first, with the setting still off.
    h.tap();
    assert.equal(h.els.length, 0);
    // Then the click's own handler turns it on and blesses.
    on = true;
    const done = h.unlock.blessPool();
    assert.ok(h.els.every((el) => el.plays === 1));
    for (const el of h.els) el.settle(true);
    assert.equal(await done, true);
  });

  test("the pool listens again when the context leaves running or the audio session is interrupted", async () => {
    const h = harness();
    h.unlock.arm(() => true);
    h.tap();
    for (const el of h.els) el.settle(true);
    await flush();
    const session = Object.assign(new EventTarget(), { type: "auto", state: "active" as string });
    let left = 0;
    let changed = 0;
    const stop = watchAudio(
      h.ctx,
      session as unknown as Parameters<typeof watchAudio>[1],
      () => {
        left++;
        h.unlock.rearm();
      },
      () => changed++,
    );
    h.ctx.change("running");
    assert.equal(left, 0);
    h.ctx.change("interrupted");
    assert.equal(left, 1);
    h.tap();
    assert.ok(h.els.every((el) => el.plays === 2), "listening again after the context left running");
    for (const el of h.els) el.settle(true);
    await flush();
    session.state = "inactive";
    session.dispatchEvent(new Event("statechange"));
    assert.equal(left, 1, "a session at rest is not an interruption");
    session.state = "interrupted";
    session.dispatchEvent(new Event("statechange"));
    assert.equal(left, 2);
    h.tap();
    assert.ok(h.els.every((el) => el.plays === 3), "listening again after the session was interrupted");
    assert.ok(changed >= 4);
    stop();
  });

  test("a TV browser without Web Audio or createMediaElementSource cannot mix, so the display shows its can't-play line", () => {
    const g = globalThis as Record<string, unknown>;
    const before = { window: g.window, Audio: g.Audio };
    try {
      g.Audio = function Audio() {};
      g.window = {};
      assert.equal(mixerSupported(), false, "no AudioContext");
      g.window = { AudioContext: class {} };
      assert.equal(mixerSupported(), false, "no createMediaElementSource");
      g.window = { webkitAudioContext: class { createMediaElementSource() {} } };
      assert.equal(mixerSupported(), true, "Safari's prefixed context counts");
      g.window = { AudioContext: class { createMediaElementSource() {} } };
      assert.equal(mixerSupported(), true);
    } finally {
      g.window = before.window;
      g.Audio = before.Audio;
    }
  });
});
