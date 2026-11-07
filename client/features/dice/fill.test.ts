import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RoomScope } from "../../state/scope.ts";
import { diceFillSlot, fillDiceField, takeDiceFill } from "./fill.ts";

describe("a formula put in the Dice field unrolled (docs/design/design-v1-qol.md 5, Acting)", () => {
  test("the field takes the newest ask once, an ask made before it drew included", () => {
    const scope = new RoomScope();
    const store = scope.get(diceFillSlot);
    assert.equal(takeDiceFill(store), null, "nothing asked");
    fillDiceField(scope, "2d6+3");
    fillDiceField(scope, "1d20+5");
    assert.equal(takeDiceFill(store), "1d20+5");
    assert.equal(takeDiceFill(store), null, "a field drawn again takes it no more");
    fillDiceField(scope, "1d20+5");
    assert.equal(takeDiceFill(store), "1d20+5", "the same formula asked again is a new ask");
  });

  test("each Room page has its own", () => {
    const a = new RoomScope();
    const b = new RoomScope();
    fillDiceField(a, "1d8");
    assert.equal(takeDiceFill(b.get(diceFillSlot)), null);
    assert.equal(takeDiceFill(a.get(diceFillSlot)), "1d8");
  });
});
