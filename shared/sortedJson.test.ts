import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { inSortedOrder, sortedJson } from "./sortedJson.ts";
import { rng } from "./testutil.ts";
import { markFinished, markWritable } from "./writable.ts";

/** A random JSON-like value: objects with short random keys (some reading as array indexes), lists, and leaves of every kind JSON.stringify treats apart. */
function randomValue(r: () => number, depth: number): unknown {
  const roll = r();
  if (depth <= 0 || roll < 0.3) {
    const leaves = [0, -0, 1.5, 1e21, Number.NaN, Infinity, "", "a\"b\\\n ", "\ud800", true, false, null, undefined];
    return leaves[Math.floor(r() * leaves.length)];
  }
  if (roll < 0.55) return Array.from({ length: Math.floor(r() * 5) }, () => randomValue(r, depth - 1));
  const names = ["id", "x", "y", "rev", "sceneId", "a b", "10", "9", "0", "é", "Z", "_", "\u0000k", "toJSONx", "__proto__"];
  // As own properties, as JSON.parse makes them, "__proto__" included.
  return Object.fromEntries(Array.from({ length: Math.floor(r() * 7) }, () => [names[Math.floor(r() * names.length)]!, randomValue(r, depth - 1)]));
}

/** The same value with each object's keys put in a random order at every depth. */
function shuffled(value: unknown, r: () => number): unknown {
  if (Array.isArray(value)) return value.map((item) => shuffled(item, r));
  if (typeof value !== "object" || value === null) return value;
  const names = Object.keys(value);
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [names[i], names[j]] = [names[j]!, names[i]!];
  }
  return Object.fromEntries(names.map((name) => [name, shuffled((value as Record<string, unknown>)[name], r)]));
}

describe("sortedJson", () => {
  test("writes every object's keys in sorted order at every depth and every list in its own order", () => {
    const value = { z: [{ b: 1, a: 2 }, 3, { d: { y: 1, x: 2 }, c: null }], a: { k: "v", j: [2, 1] } };
    assert.equal(sortedJson(value), '{"a":{"j":[2,1],"k":"v"},"z":[{"a":2,"b":1},3,{"c":null,"d":{"x":2,"y":1}}]}');
  });

  test("keeps a \"__proto__\" key as a key", () => {
    assert.equal(sortedJson(JSON.parse('{"b":1,"__proto__":{"y":1,"x":2}}')), '{"__proto__":{"x":2,"y":1},"b":1}');
  });

  test("a value already in sorted order is the value itself, written as JSON.stringify writes it", () => {
    const value = { a: { b: [1, { c: 2, d: 3 }] }, e: "f" };
    assert.equal(inSortedOrder(value), value);
    assert.equal(sortedJson(value), JSON.stringify(value));
  });

  test("leaves out and writes as null what JSON.stringify does, and reads toJSON", () => {
    // eslint-disable-next-line no-sparse-arrays
    const value = { u: undefined, f: () => 1, list: [undefined, () => 1, , Number.NaN, -Infinity], when: new Date(0), wrapped: { toJSON: () => ({ y: 1, x: 2 }) } };
    assert.equal(sortedJson(value), '{"list":[null,null,null,null,null],"when":"1970-01-01T00:00:00.000Z","wrapped":{"x":2,"y":1}}');
    assert.equal(sortedJson(undefined), "null");
  });

  test("the same value gives the same text however its keys were ordered, and the text reads back to the value", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const value = randomValue(r, 4);
      const text = sortedJson(value);
      assert.equal(sortedJson(shuffled(value, r)), text, `seed ${seed}`);
      assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(value) ?? "null"), `seed ${seed}: the same value`);
      assert.equal(JSON.stringify(JSON.parse(text)), text, `seed ${seed}: the text is already in the order it reads back in`);
    }
  });

  test("an object a transaction may still write into is checked again each time", () => {
    const value: Record<string, number> = { b: 1 };
    markWritable(value);
    assert.equal(sortedJson(value), '{"b":1}');
    value.a = 2;
    assert.equal(sortedJson(value), '{"a":2,"b":1}');
    markFinished(value);
  });
});
