import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS } from "./limits.ts";
import { clientOpSchema, opSchema } from "./protocol.ts";

/*
 * The op a trap's Apply sends from change format 66 (docs/design/design-v1-traps.md
 * 6.2): `actor.outcome`'s `trap` names the creatures it settles, at most as
 * many as an occurrence names, so the occurrence keeps every other.
 */

const parses = (op: unknown) => opSchema.safeParse(op).success;
const outcome = (trap: object) => ({ t: "actor.outcome", plan: "p1", trap, targets: [{ target: { tokenId: "t0" }, amount: 3 }] });
const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

describe("a trap outcome's creatures", () => {
  test("names at most as many as an occurrence does: 50 pass, and 51 are refused", () => {
    assert.equal(LIMITS.trapHits, 50);
    assert.ok(parses(outcome({ trapId: "pit", due: "5:0", tokenIds: ids(LIMITS.trapHits) })));
    assert.ok(clientOpSchema.safeParse(outcome({ trapId: "pit", due: "5:0", tokenIds: ids(LIMITS.trapHits) })).success, "a DM page sends it");
    assert.ok(!parses(outcome({ trapId: "pit", due: "5:0", tokenIds: ids(LIMITS.trapHits + 1) })));
  });

  test("may name none, or leave them out for a whole settle, and takes only ids and nothing else", () => {
    assert.ok(parses(outcome({ trapId: "pit", due: "5:0", tokenIds: [] })));
    assert.ok(parses(outcome({ trapId: "pit", due: "5:0" })));
    assert.ok(!parses(outcome({ trapId: "pit", due: "5:0", tokenIds: [""] })));
    assert.ok(!parses(outcome({ trapId: "pit", due: "5:0", tokenIds: "t0" })));
    assert.ok(!parses(outcome({ trapId: "pit", due: "5:0", tokenIds: ["t0"], hits: ["t1"] })), "the shape is strict");
  });
});
