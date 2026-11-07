import assert from "node:assert/strict";
import { test } from "node:test";
import { preloadInBackground, preloadLazies, retryableLazy, roleMayLoad, type Network } from "./retryableLazy.ts";

test("a DM-only part never loads for a player, and a part with no role in its props loads for everyone", () => {
  // The map's layers carry the viewer's role (features/layers.ts LayerProps), so a player's height marks and explored outline are never mounted.
  assert.equal(roleMayLoad(["dm"], "player"), false);
  assert.equal(roleMayLoad(["dm"], "dm"), true);
  assert.equal(roleMayLoad(["dm", "player"], "player"), true);
  assert.equal(roleMayLoad(["dm"], undefined), true);
  assert.equal(roleMayLoad(["player"], "dm"), false);
});

test("the background loads wait while the device is offline, start once it is back online, and start only once", () => {
  const loads: string[] = [];
  preloadInBackground(async () => void loads.push("both"), ["dm", "player"]);
  preloadInBackground(async () => void loads.push("dm"), ["dm"]);
  let online = false;
  const waiting: (() => void)[] = [];
  const network: Network = { online: () => online, onceOnline: (go) => void waiting.push(go) };

  preloadLazies("dm", network);
  preloadLazies("dm", network);
  assert.deepEqual(loads, [], "nothing starts offline, where it could only fail");
  assert.equal(waiting.length, 2, "each call waits for the device to be back online");

  online = true;
  for (const go of waiting.splice(0)) go();
  assert.deepEqual(loads, ["both", "dm"], "back online, each load starts once");
  preloadLazies("dm", network);
  preloadLazies("player", network);
  assert.deepEqual(loads, ["both", "dm"], "a load already started never starts again, and the DM's never starts for a player");
});

/*
 * A part preloaded in the background draws in its first render. React.lazy
 * suspended there even with the code here, and React reveals what a
 * Suspense boundary waited for only some 300 ms after its fallback, so the
 * party bar came in late over the side panel's tabs and pushed the panel
 * down (D-261106-393).
 */
test("a part whose code was preloaded draws in its first render, and one that loads on its mount waits for it", async () => {
  const { createElement, Suspense } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const online: Network = { online: () => true, onceOnline: () => {} };
  const word = (props: { word: string }) => createElement("b", null, props.word);
  let loads = 0;
  const Preloaded = retryableLazy(async () => (loads++, { default: word }), { roles: ["dm"] });
  const OnMount = retryableLazy(async () => ({ default: word }));
  const draw = (Part: typeof Preloaded) => renderToStaticMarkup(createElement(Suspense, { fallback: "waiting" }, createElement(Part, { word: "here" })));

  preloadLazies("dm", online);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(draw(Preloaded), "<b>here</b>", "preloaded, it never shows its fallback");
  assert.equal(loads, 1, "and its code is not asked for again");
  assert.equal(draw(OnMount), "waiting", "a part whose code is not here yet still waits for it");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(draw(OnMount), "<b>here</b>", "and draws once it is");
});
