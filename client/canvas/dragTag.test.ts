import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Member } from "#shared/model.ts";
import { theme } from "../lib/theme.ts";
import { dragTag } from "./dragTag.ts";

describe("the name tag on someone else's drag", () => {
  test("names who is dragging, in their color", () => {
    const members = { pia: { id: "pia", name: "Pia", color: "#3e8ef7" } as Member };
    assert.deepEqual(dragTag("pia", members), { text: "Pia", color: "#3e8ef7" });
  });

  test("a member who left reads as someone, in the crest yellow", () => {
    assert.deepEqual(dragTag("gone", {}), { text: "Someone", color: theme.color.crest });
    assert.deepEqual(dragTag("gone", undefined), { text: "Someone", color: theme.color.crest });
  });
});
