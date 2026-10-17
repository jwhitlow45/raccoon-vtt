import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { useSrdBlocks } from "./srdBlocks.ts";

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
