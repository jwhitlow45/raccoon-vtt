import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { blocksFailed, useSrdBlocks } from "./srdBlocks.ts";

/* Every view that shows the SRD blocks reads them as one external store (GGA-05). */

function Count() {
  const { list } = useSrdBlocks();
  return createElement("p", null, list ? `${list.length} blocks` : "Loading");
}

test("a view drawn before the load shows it loading, and one drawn after shows the blocks in its first frame", async () => {
  assert.equal(renderToStaticMarkup(createElement(Count)), "<p>Loading</p>");
  await loadMonsters();
  assert.equal(renderToStaticMarkup(createElement(Count)), "<p>330 blocks</p>");
});

test("a failed load counts only for its attempt and only until the blocks load: a pick of another creature tries again", () => {
  const blocks = [] as const;
  assert.equal(blocksFailed(null, "c:thorn", "c:thorn"), true, "the attempt that failed says so");
  assert.equal(blocksFailed(null, "c:thorn", "t:wolf"), false, "another creature's attempt starts unfailed, and its effect loads again");
  assert.equal(blocksFailed(blocks, "c:thorn", "c:thorn"), false, "a later load, by any view, clears it");
  assert.equal(blocksFailed(null, null, ""), false);
});
