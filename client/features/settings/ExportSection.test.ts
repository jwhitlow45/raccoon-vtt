import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const { ADMIN_COMMAND_STYLE } = await import("./ExportSection.tsx");

test("the backup command wraps at its spaces and never breaks every character", () => {
  assert.equal(ADMIN_COMMAND_STYLE.whiteSpace, "pre-wrap");
  assert.equal(ADMIN_COMMAND_STYLE.overflowWrap, "break-word");
  assert.ok(!("wordBreak" in ADMIN_COMMAND_STYLE));
});
