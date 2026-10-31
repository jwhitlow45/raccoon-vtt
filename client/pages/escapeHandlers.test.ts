import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

/** Exercise the installed callback without mounting the room or opening sockets. */
function escapeHandler(path: string, marker: string, name: string, close: () => void): (event: KeyboardEvent) => void {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const after = source.indexOf(marker);
  assert.ok(after >= 0, `missing ${marker}`);
  const start = source.indexOf("const onKey =", after);
  const end = source.indexOf("\n    };", start);
  assert.ok(start >= 0 && end > start);
  const body = stripTypeScriptTypes(source.slice(start, end + "\n    };".length));
  return new Function(name, `${body}\nreturn onKey;`)(close) as (event: KeyboardEvent) => void;
}
function key(value: string): KeyboardEvent {
  return Object.assign(new Event("keydown", { cancelable: true }), { key: value }) as KeyboardEvent;
}

for (const [name, path, marker, callback] of [
  ["alerts overlay", "../features/encounter/InitiativeStrip.tsx", "if (!overlay) return;", "closeOverlay"],
] as const) test(`${name} leaves an Escape already used by a popover alone`, () => {
  let closed = 0;
  const handler = escapeHandler(path, marker, callback, () => closed++);
  const used = key("Escape");
  used.preventDefault();
  handler(used);
  assert.equal(closed, 0, "the host stays open after the popover consumes Escape");
  assert.equal(used.cancelBubble, false, "the used key is left alone");
  handler(key("Enter"));
  assert.equal(closed, 0);
  handler(key("Escape"));
  assert.equal(closed, 1, "a later unused Escape still closes the host");
});

test("expanded toast leaves an Escape already used by a popover alone", async () => {
  const { listenToastEscape } = await import("./toastEscape.ts");
  const saved = { window: globalThis.window, document: globalThis.document };
  // A recording window that keeps its own listeners: on CI's Node 24, a capture listener removed from a real EventTarget stayed attached.
  const listening = new Set<(event: Event) => void>();
  const added: Parameters<EventTarget["addEventListener"]>[] = [];
  const removed: Parameters<EventTarget["removeEventListener"]>[] = [];
  const window = {
    addEventListener: (...args: Parameters<EventTarget["addEventListener"]>) => (added.push(args), listening.add(args[1] as (event: Event) => void)),
    removeEventListener: (...args: Parameters<EventTarget["removeEventListener"]>) => (removed.push(args), listening.delete(args[1] as (event: Event) => void)),
  };
  const target = { dispatchEvent: (event: Event) => { for (const listener of [...listening]) listener(event); } };
  Object.assign(globalThis, { window, document: { querySelectorAll: () => [] } });
  let closed = 0;
  const stop = listenToastEscape(() => closed++);
  try {
    assert.equal(added.length, 1);
    const [name, callback, capture] = added[0]!;
    assert.equal(name, "keydown");
    assert.equal(capture, true, "the production listener runs in capture");
    const used = key("Escape");
    used.preventDefault();
    target.dispatchEvent(used);
    assert.equal(closed, 0, "the toast stays expanded after the popover consumes Escape");
    assert.equal(used.cancelBubble, false);
    target.dispatchEvent(key("Enter"));
    assert.equal(closed, 0);
    const unused = key("Escape");
    target.dispatchEvent(unused);
    assert.equal(closed, 1, "a later unused Escape still shrinks the toast");
    assert.equal(unused.defaultPrevented, true, "the room cannot also consume this Escape");
    stop();
    assert.equal(removed.length, 1, "cleanup removes the listener");
    assert.deepEqual(removed[0], ["keydown", callback, true]);
    target.dispatchEvent(key("Escape"));
    assert.equal(closed, 1, "cleanup detaches the installed callback");
  } finally {
    stop();
    Object.assign(globalThis, saved);
  }
});
