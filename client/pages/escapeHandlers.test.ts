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
  ["expanded toast", "./Room.tsx", "if (wholeToast === undefined) return;", "shrink"],
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
