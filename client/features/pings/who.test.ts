import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Member } from "#shared/model.ts";
import { markOwner } from "./who.ts";

describe("whose mark it is", () => {
  const members = { pia: { id: "pia", name: "Pia" } as Member };

  test("someone else's ping, laser or ruler names them", () => {
    assert.equal(markOwner({ from: "pia", local: false }, members), "Pia");
  });

  test("your own carries no name, and a member who left reads as someone", () => {
    assert.equal(markOwner({ from: "pia", local: true }, members), null);
    assert.equal(markOwner({ from: "gone", local: false }, members), "Someone");
  });
});
