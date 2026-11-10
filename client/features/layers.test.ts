import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** layers.ts pulls in .tsx renderers that node cannot load, so the registry is read as text. */
function orderOf(id: string): number {
  const source = readFileSync(new URL("./layers.ts", import.meta.url), "utf8");
  const match = new RegExp(`id: "${id}", layer: "board", order: (\\d+)`).exec(source);
  assert.ok(match, `${id} is not a board layer`);
  return Number(match[1]);
}

test("the stairs draft is drawn after the placed stairs, so a refusal's red is not covered", () => {
  assert.ok(orderOf("linkDraft") > orderOf("floorLinks"));
});
