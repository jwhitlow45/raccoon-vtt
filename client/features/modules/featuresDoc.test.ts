import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { keyLabel } from "../../state/keyBindings.ts";
import { DEFAULT_KEYS } from "../../state/shortcuts.ts";
import { MODULES } from "./registry.ts";

/*
 * FEATURES.md's Features entry lists each part's keys (docs/design/design-v1-features.md
 * 7, D-261127-120), made here from the registry's claims and the default
 * keys, so a part that gains or loses a key changes the sentence with it.
 */

/** "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

test("FEATURES.md's keys-by-part sentence matches the parts' claims word for word", () => {
  const parts = MODULES.flatMap((m) => {
    const keys = m.claims.flatMap((c) => (c.kind === "shortcut" && DEFAULT_KEYS[c.id] !== undefined ? [keyLabel(DEFAULT_KEYS[c.id]!)] : []));
    return keys.length > 0 ? [`${m.name} ${listed(keys)}`] : [];
  });
  const sentence = `Hiding a part takes its keys off the list, and they do nothing: ${parts.join(", ")}.`;
  assert.equal(sentence, "Hiding a part takes its keys off the list, and they do nothing: Ruler R, Areas A, Draw D, Ping and laser P, Map pins M, Traps X, Map builder B, Sound U, Outliner /, Isometric view I, Q and E.");
  assert.ok(readFileSync(new URL("../../../FEATURES.md", import.meta.url), "utf8").includes(sentence), sentence);
});
