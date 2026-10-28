import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SQUARES } from "#shared/rules/grid.ts";
import { HEX_LIMITS } from "../grid/words.ts";

const { brushTitle, revealRoomOff } = await import("./Options.tsx");

describe("the fog tool on a hex scene (H1)", () => {
  test("Reveal room is off with its reason on either hex shape", () => {
    assert.equal(revealRoomOff({ gridShape: "hexRows" }), HEX_LIMITS.revealRoom);
    assert.equal(revealRoomOff({ gridShape: "hexColumns" }), HEX_LIMITS.revealRoom);
  });
  test("Reveal room works on a square scene", () => {
    assert.equal(revealRoomOff({}), null);
  });
  test("the brush width title reads the cell word", () => {
    assert.equal(brushTitle(1, SQUARES), "1 square wide");
    assert.equal(brushTitle(3, SQUARES), "3 squares wide");
    assert.equal(brushTitle(1, { shape: "hex", orient: "rows" }), "1 hex wide");
    assert.equal(brushTitle(3, { shape: "hex", orient: "rows" }), "3 hexes wide");
  });
});
