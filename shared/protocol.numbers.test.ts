import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NUMBER_FROM_TABLE, clientOpSchema, opSchema, serverOnlyOpSchema } from "./protocol.ts";
import { token } from "./testutil.ts";

const goblin = () => {
  const { id, sceneId, kind, name, size, x, y, actor } = token("g1");
  return { id, sceneId, kind, name, size, x, y, actor };
};

describe("creature numbers in the protocol", () => {
  test("a client's create or update that sends a number, null included, is refused", () => {
    for (const op of [
      { t: "token.create", token: { ...goblin(), number: 3 } },
      { t: "token.update", tokenId: "g1", patch: { number: 2 } },
      { t: "token.update", tokenId: "g1", patch: { number: null } },
    ]) {
      const parsed = clientOpSchema.safeParse(op);
      assert.ok(!parsed.success, `${op.t} is refused`);
      assert.equal(parsed.error.issues[0]?.message, NUMBER_FROM_TABLE);
    }
    assert.ok(clientOpSchema.safeParse({ t: "token.create", token: goblin() }).success);
    assert.ok(clientOpSchema.safeParse({ t: "token.update", tokenId: "g1", patch: { name: "Orc" } }).success);
  });

  test("a stored op with a number still parses for replay", () => {
    assert.ok(opSchema.safeParse({ t: "token.create", token: { ...goblin(), number: 3 } }).success);
    assert.ok(opSchema.safeParse({ t: "token.update", tokenId: "g1", patch: { number: null } }).success);
  });

  test("a meeting names one to 500 creatures, once each, in id order", () => {
    const meet = (tokenIds: string[]) => serverOnlyOpSchema.safeParse({ t: "sys.meet", tokenIds }).success;
    assert.ok(meet(["a", "b", "c"]));
    assert.ok(meet(Array.from({ length: 500 }, (_, i) => `t${String(i).padStart(3, "0")}`)));
    assert.ok(!meet([]));
    assert.ok(!meet(Array.from({ length: 501 }, (_, i) => `t${String(i).padStart(3, "0")}`)));
    assert.ok(!meet(["b", "a"]));
    assert.ok(!meet(["a", "a"]));
    assert.ok(!clientOpSchema.safeParse({ t: "sys.meet", tokenIds: ["a"] }).success, "a client never sends one");
  });
});
