import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { enterFullscreen, exitFullscreen, fullscreenSupported, isFullscreen, subscribeFullscreen, toggleFullscreen, type FullscreenDocument, type KeyboardLock } from "./fullscreen.ts";

/** A document's full screen with its events, in the standard form, the webkit form of older Safari, or neither (iPhone Safari). */
class FakeDocument implements FullscreenDocument {
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
  fullscreenElement?: unknown;
  webkitFullscreenElement?: unknown;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => void;
  documentElement: FullscreenDocument["documentElement"] = {};
  readonly asked: unknown[] = [];
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(form: "standard" | "webkit" | "none", opts: { refuse?: boolean } = {}) {
    const root = this.documentElement;
    if (form === "standard") {
      this.fullscreenEnabled = true;
      this.fullscreenElement = null;
      root.requestFullscreen = async (options) => {
        this.asked.push(options);
        if (opts.refuse) throw new TypeError("Permissions check failed");
        this.fullscreenElement = root;
        this.fire("fullscreenchange");
      };
      this.exitFullscreen = async () => {
        if (this.fullscreenElement === null) throw new TypeError("Not in fullscreen mode");
        this.fullscreenElement = null;
        this.fire("fullscreenchange");
      };
    } else if (form === "webkit") {
      this.webkitFullscreenEnabled = true;
      this.webkitFullscreenElement = null;
      root.webkitRequestFullscreen = () => {
        this.asked.push("webkit");
        this.webkitFullscreenElement = root;
        this.fire("webkitfullscreenchange");
      };
      this.webkitExitFullscreen = () => {
        this.webkitFullscreenElement = null;
        this.fire("webkitfullscreenchange");
      };
    } else {
      this.fullscreenEnabled = false;
    }
  }

  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  fire(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  /** The browser leaves full screen on its own: Escape, a held Escape, or its own control. */
  browserLeaves(): void {
    if (this.fullscreenElement !== undefined) this.fullscreenElement = null;
    if (this.webkitFullscreenElement !== undefined) this.webkitFullscreenElement = null;
    this.fire("fullscreenchange");
    this.fire("webkitfullscreenchange");
  }
}

/** Keyboard Lock as Chrome has it, recording each call. */
function fakeKeyboard(opts: { refuse?: boolean } = {}): KeyboardLock & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    lock: async (keys) => {
      calls.push(`lock ${keys?.join(",") ?? "all"}`);
      if (opts.refuse) throw new DOMException("not allowed", "InvalidStateError");
    },
    unlock: () => calls.push("unlock"),
  };
}

describe("whether the page can go full screen", () => {
  test("in the standard form and in older Safari's webkit form, never on iPhone Safari or in a frame that does not allow it", () => {
    assert.equal(fullscreenSupported(new FakeDocument("standard")), true);
    assert.equal(fullscreenSupported(new FakeDocument("webkit")), true);
    assert.equal(fullscreenSupported(new FakeDocument("none")), false, "iPhone Safari");
    assert.equal(fullscreenSupported(null), false, "no document");
    const framed = new FakeDocument("standard");
    framed.fullscreenEnabled = false;
    assert.equal(fullscreenSupported(framed), false, "a frame without allowfullscreen");
    const noRequest = new FakeDocument("standard");
    delete noRequest.documentElement.requestFullscreen;
    assert.equal(fullscreenSupported(noRequest), false, "enabled with nothing to ask it with");
  });

  test("the page's own full screen counts in either form, and the browser's own full screen, which leaves both empty, does not", () => {
    const doc = new FakeDocument("standard");
    assert.equal(isFullscreen(doc), false, "F11 or the green button sets neither element");
    doc.fullscreenElement = doc.documentElement;
    assert.equal(isFullscreen(doc), true);
    const old = new FakeDocument("webkit");
    assert.equal(isFullscreen(old), false);
    old.webkitFullscreenElement = old.documentElement;
    assert.equal(isFullscreen(old), true);
    assert.equal(isFullscreen(null), false);
  });
});

describe("entering and leaving", () => {
  test("asks for the whole page, with the browser's bars hidden, and leaves again", async () => {
    const doc = new FakeDocument("standard");
    assert.equal(await enterFullscreen(doc, null), true);
    assert.equal(doc.fullscreenElement, doc.documentElement, "the document's root, so portals stay in it");
    assert.deepEqual(doc.asked, [{ navigationUI: "hide" }]);
    assert.equal(await enterFullscreen(doc, null), true, "a second press while in it");
    assert.equal(doc.asked.length, 1, "asks no second time");
    await exitFullscreen(doc);
    assert.equal(isFullscreen(doc), false);
  });

  test("older Safari takes the webkit forms both ways", async () => {
    const doc = new FakeDocument("webkit");
    assert.equal(await enterFullscreen(doc, null), true);
    assert.deepEqual(doc.asked, ["webkit"]);
    assert.equal(isFullscreen(doc), true);
    await exitFullscreen(doc);
    assert.equal(isFullscreen(doc), false);
  });

  test("a refused request, or one with no user gesture, leaves the state off and throws nothing", async () => {
    const doc = new FakeDocument("standard", { refuse: true });
    assert.equal(await enterFullscreen(doc, null), false);
    assert.equal(isFullscreen(doc), false);
    assert.equal(await enterFullscreen(new FakeDocument("none"), null), false, "where it cannot, nothing is asked");
  });

  test("leaving when the browser already left, or was never in it, throws nothing", async () => {
    const doc = new FakeDocument("standard");
    await exitFullscreen(doc);
    await enterFullscreen(doc, null);
    // The browser left between the check and the call.
    doc.exitFullscreen = async () => {
      throw new TypeError("Not in fullscreen mode");
    };
    await exitFullscreen(doc);
  });

  test("toggle enters when out and leaves when in, in both forms", async () => {
    for (const form of ["standard", "webkit"] as const) {
      const doc = new FakeDocument(form);
      await toggleFullscreen(doc, null);
      assert.equal(isFullscreen(doc), true, `${form}: in`);
      await toggleFullscreen(doc, null);
      assert.equal(isFullscreen(doc), false, `${form}: out`);
      await toggleFullscreen(doc, null);
      assert.equal(isFullscreen(doc), true, `${form}: in again`);
    }
  });
});

describe("Escape while in full screen", () => {
  test("is locked once the page is in full screen and let go when it leaves, by the button or by the browser", async () => {
    const doc = new FakeDocument("standard");
    const keyboard = fakeKeyboard();
    await enterFullscreen(doc, keyboard);
    assert.deepEqual(keyboard.calls, ["lock Escape"]);
    await exitFullscreen(doc);
    assert.deepEqual(keyboard.calls, ["lock Escape", "unlock"]);
    await enterFullscreen(doc, keyboard);
    doc.browserLeaves();
    assert.deepEqual(keyboard.calls, ["lock Escape", "unlock", "lock Escape", "unlock"], "a held Escape lets go of the lock too");
    assert.equal(doc.count("fullscreenchange"), 1, "one listener for the document, however often it enters");
  });

  test("a refused lock, or a browser with no Keyboard Lock, still enters", async () => {
    const doc = new FakeDocument("standard");
    assert.equal(await enterFullscreen(doc, fakeKeyboard({ refuse: true })), true);
    assert.equal(isFullscreen(doc), true);
    const other = new FakeDocument("standard");
    assert.equal(await enterFullscreen(other, null), true);
    assert.equal(other.count("fullscreenchange"), 0, "nothing to follow without the lock");
  });
});

describe("following the state", () => {
  test("hears both forms' change events, reads the state each time, and stops hearing both", async () => {
    const doc = new FakeDocument("standard");
    const seen: boolean[] = [];
    const stop = subscribeFullscreen(() => seen.push(isFullscreen(doc)), doc);
    await enterFullscreen(doc, null);
    doc.browserLeaves();
    assert.deepEqual(seen, [true, false, false], "the standard event, then the browser leaving, which fires both");
    stop();
    assert.equal(doc.count("fullscreenchange") + doc.count("webkitfullscreenchange"), 0);
    await enterFullscreen(doc, null);
    assert.equal(seen.length, 3, "nothing after the unsubscribe");
  });

  test("an older Safari's webkit event alone is heard", async () => {
    const doc = new FakeDocument("webkit");
    const seen: boolean[] = [];
    const stop = subscribeFullscreen(() => seen.push(isFullscreen(doc)), doc);
    await toggleFullscreen(doc, null);
    await toggleFullscreen(doc, null);
    assert.deepEqual(seen, [true, false]);
    stop();
  });

  test("with no document, the unsubscribe is a no-op", () => {
    const stop = subscribeFullscreen(() => assert.fail("no events"), null);
    stop();
  });
});
