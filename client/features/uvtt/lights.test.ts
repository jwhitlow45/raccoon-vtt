import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { lightColor } from "./lights.ts";

describe("light colors", () => {
  test("keep the last six hex digits", () => {
    assert.equal(lightColor("ffeccd8b"), "#eccd8b");
    assert.equal(lightColor("#A0B1C2"), "#a0b1c2");
    assert.equal(lightColor("fff"), undefined);
    assert.equal(lightColor("orange"), undefined);
    assert.equal(lightColor(null), undefined);
  });
});
