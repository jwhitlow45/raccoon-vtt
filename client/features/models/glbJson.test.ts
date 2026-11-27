import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MODEL_LIMITS } from "#shared/limits.ts";
import { jsonCaps, prescanJson } from "./glbJson.ts";

/** The GLB JSON pre-scan (docs/design/design-v1-token-models.md 5, D-261127-510): every cap at and past its limit, and strings that would fool a careless count. */

const enc = (s: string) => new TextEncoder().encode(s);
const scan = (s: string, device: "touch" | "computer" = "computer") => prescanJson(enc(s), jsonCaps(device));

/** How many values `JSON.parse` makes of a text: every container, key and scalar. */
function parsedValues(s: string): { values: number; containers: number } {
  let values = 0;
  let containers = 0;
  const walk = (v: unknown) => {
    values++;
    if (Array.isArray(v)) {
      containers++;
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      containers++;
      for (const [, x] of Object.entries(v)) {
        values++;
        walk(x);
      }
    }
  };
  walk(JSON.parse(s));
  return { values, containers };
}

describe("the GLB JSON pre-scan", () => {
  test("counts what JSON.parse makes: containers, keys and scalars", () => {
    const text = '{"asset":{"version":"2.0"},"nodes":[{"mesh":0,"name":"a"},{"children":[0],"matrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}],"x":[true,false,null,-1.5e3]}';
    const { values, containers } = parsedValues(text);
    assert.equal(scan(text), null);
    assert.equal(prescanJson(enc(text), { bytes: 1e6, depth: 64, containers, values: values - 1 }), "values");
    assert.equal(prescanJson(enc(text), { bytes: 1e6, depth: 64, containers: containers - 1, values }), "containers");
    assert.equal(prescanJson(enc(text), { bytes: 1e6, depth: 64, containers, values }), null);
  });

  test("skips strings whole: escaped quotes, backslashes, brackets and braces inside never count", () => {
    const tricky = String.raw`{"name":"a \"quoted\" [bracket] {brace} \\","b":"\\\"[[[[[","c":"}}}]]]"}`;
    assert.deepEqual(JSON.parse(tricky).c, "}}}]]]");
    const { values, containers } = parsedValues(tricky);
    assert.equal(prescanJson(enc(tricky), { bytes: 1e6, depth: 1, containers, values }), null);
    assert.equal(prescanJson(enc(tricky), { bytes: 1e6, depth: 1, containers, values: values - 1 }), "values");
  });

  test("refuses a nesting 65 deep and takes 64", () => {
    assert.equal(scan(`${"[".repeat(64)}${"]".repeat(64)}`), null);
    assert.equal(scan(`${"[".repeat(65)}${"]".repeat(65)}`), "depth");
    assert.equal(scan(`{"extras":${'{"a":'.repeat(65)}1${"}".repeat(65)}}`), "depth");
  });

  test("refuses 200,001 empty objects on a computer and takes 200,000", () => {
    const n = MODEL_LIMITS.glbJsonComputerContainers;
    assert.equal(scan(`[${"{},".repeat(n - 2)}{}]`), null);
    assert.equal(scan(`[${"{},".repeat(n - 1)}{}]`), "containers");
  });

  test("refuses 50,001 containers on touch and takes 50,000", () => {
    const n = MODEL_LIMITS.glbJsonTouchContainers;
    assert.equal(scan(`[${"[],".repeat(n - 2)}[]]`, "touch"), null);
    assert.equal(scan(`[${"[],".repeat(n - 2)}[]]`, "computer"), null);
    assert.equal(scan(`[${"[],".repeat(n - 1)}[]]`, "touch"), "containers");
  });

  test("refuses an extras subtree past the value count", () => {
    // The object, its key and the array are 3 values, and each number one more.
    const values = MODEL_LIMITS.glbJsonComputerValues;
    const at = `{"extras":[${"0,".repeat(values - 4)}0]}`;
    assert.equal(parsedValues(at).values, values);
    assert.equal(scan(at), null);
    assert.equal(scan(`{"extras":[${"0,".repeat(values - 3)}0]}`), "values");
    assert.equal(scan(`{"extras":[${"0,".repeat(MODEL_LIMITS.glbJsonTouchValues - 3)}0]}`, "touch"), "values");
  });

  test("counts keys as values, as JSON.parse makes a string of each", () => {
    const keys = `{"extras":{${Array.from({ length: 1000 }, (_, i) => `"k${i}":${i}`).join(",")}}}`;
    assert.equal(parsedValues(keys).values, 2003);
    assert.equal(prescanJson(enc(keys), { bytes: 1e6, depth: 64, containers: 10, values: 2003 }), null);
    assert.equal(prescanJson(enc(keys), { bytes: 1e6, depth: 64, containers: 10, values: 2002 }), "values");
  });

  test("refuses a chunk past 16 MB on a computer and 4 MB on touch before reading a byte of it", () => {
    const spaces = (n: number) => new Uint8Array(n).fill(0x20);
    assert.equal(prescanJson(spaces(MODEL_LIMITS.glbJsonTouchBytes), jsonCaps("touch")), null);
    assert.equal(prescanJson(spaces(MODEL_LIMITS.glbJsonTouchBytes + 1), jsonCaps("touch")), "bytes");
    assert.equal(prescanJson(spaces(MODEL_LIMITS.glbJsonComputerBytes + 1), jsonCaps("computer")), "bytes");
    assert.equal(prescanJson(spaces(MODEL_LIMITS.glbJsonComputerBytes), jsonCaps("computer")), null);
  });

  test("lets malformed JSON through for JSON.parse to refuse, without running past the end", () => {
    assert.equal(scan('{"unterminated'), null);
    assert.equal(scan("]]]]"), null);
    assert.equal(scan('"\\'), null);
  });
});
