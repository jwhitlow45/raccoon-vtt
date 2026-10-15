import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { printable } from "./printable.ts";

describe("printable", () => {
  test("terminal escapes, C1 controls and bidi controls come out as visible escapes", () => {
    assert.equal(printable("\u001b]0;pwned\u0007\u001b[2JRoom"), "\\u{1b}]0;pwned\\u{7}\\u{1b}[2JRoom");
    assert.equal(printable("a\u009b31mb"), "a\\u{9b}31mb");
    assert.equal(printable("evil‮txt.exe"), "evil\\u{202e}txt.exe");
  });

  test("ordinary names are unchanged", () => {
    for (const name of ["The Owlbear's Den", "Café du Dragon", "梟熊の巣", "Room 🦉"]) assert.equal(printable(name), name);
  });
});
