import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

for (const [file, text] of [
  ["../features/monsters/MonsterImage.tsx", "Undo setup in Setup history takes them all back."],
  ["../features/journal/JournalPanel.tsx", "Undo setup in Setup history brings both back."],
  ["../features/tokens/GroupMoreSheet.tsx", "Use Undo for size. Use Undo setup in Setup history for the other settings."],
] as const) test(`${file} names the correct history controls`, () => {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  assert.ok(source.includes(text), text);
});
