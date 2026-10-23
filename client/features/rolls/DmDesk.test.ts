import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { deskUnnamed } = await import("./DmDesk.tsx");

describe("the DM desk's line in the alerts summary (LP16-PT-3)", () => {
  test("its words name the traps that went off, so the asks for saves and roll requests count as more", () => {
    assert.equal(deskUnnamed({ traps: 1, asks: 2, cards: 0 }), 2);
    assert.equal(deskUnnamed({ traps: 2, asks: 1, cards: 3 }), 4);
  });

  test("with no trap the asks lead, and the roll requests count as more", () => {
    assert.equal(deskUnnamed({ traps: 0, asks: 2, cards: 3 }), 3);
  });

  test("the roll requests alone are named together", () => {
    assert.equal(deskUnnamed({ traps: 0, asks: 0, cards: 3 }), 0);
    assert.equal(deskUnnamed({ traps: 1, asks: 0, cards: 0 }), 0);
  });
});
