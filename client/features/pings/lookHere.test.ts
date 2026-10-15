import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ephEventSchema } from "#shared/protocol.ts";
import { lookHereEvent } from "./lookHere.ts";

describe("look here", () => {
  test("a DM zoomed past 100 px per cell sends a focus the server accepts", () => {
    const e = lookHereEvent({ x: 12.5, y: 7 }, 160);
    assert.deepEqual(e, { k: "focus", x: 12.5, y: 7, zoom: 100 });
    assert.ok(ephEventSchema.safeParse(e).success);
  });

  test("a DM zoomed far out still shows players a readable spot", () => {
    assert.equal(lookHereEvent({ x: 0, y: 0 }, 6).zoom, 24);
    assert.equal(lookHereEvent({ x: 0, y: 0 }, 48).zoom, 48);
  });
});
