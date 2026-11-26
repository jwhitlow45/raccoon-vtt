import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { OP_VERSION, SNAPSHOT_VERSION } from "./migrate.ts";

const notes = readFileSync(new URL("../docs/self-hosting.md", import.meta.url), "utf8");

// A note that forgets to name the new format would tell a host nothing about going back.
function highest(label: string): number {
  const found = [...notes.matchAll(new RegExp(`${label}\\s+format\\s+(\\d+)`, "g"))].map((m) => Number(m[1]));
  assert.ok(found.length > 0, `docs/self-hosting.md names no ${label} format`);
  return Math.max(...found);
}

describe("the self-hosting update notes", () => {
  test("the highest change format named is OP_VERSION", () => {
    assert.equal(highest("change"), OP_VERSION);
  });

  test("the highest room format named is SNAPSHOT_VERSION", () => {
    assert.equal(highest("room"), SNAPSHOT_VERSION);
  });
});
