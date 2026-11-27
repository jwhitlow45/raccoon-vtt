import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HIDDEN_TOOLS_BUTTON, SETUP_BUTTON, SETUP_TOOLS, setupDivider, TOOL_ORDER, toolbarButtons } from "./toolbarOrder.ts";

/** A role's toolbar as toolsFor sorts it, from the order table (features/tools.ts cannot load under node --test: its tools are .tsx). */
function toolbar(ids: readonly (keyof typeof TOOL_ORDER)[]) {
  return [...ids].sort((a, b) => TOOL_ORDER[a] - TOOL_ORDER[b]).map((id) => ({ id }));
}

describe("the toolbar's order (docs/design/design-v1-layout-hierarchy.md M1)", () => {
  test("the DM's play tools come first, Fog fourth, then a divider and the setup tools", () => {
    const dm = toolbar(["select", "add-token", "ruler", "area", "draw", "ping", "trap", "pin", "fog", "build", "grid"]);
    assert.deepEqual(
      dm.map((t) => t.id),
      ["select", "ruler", "area", "fog", "draw", "ping", "add-token", "pin", "trap", "build", "grid"],
    );
    assert.equal(setupDivider(dm), 6, "the divider stands before Add token");
  });

  test("a player's order does not change and has no divider", () => {
    const player = toolbar(["select", "ruler", "area", "draw", "ping"]);
    assert.deepEqual(
      player.map((t) => t.id),
      ["select", "ruler", "area", "draw", "ping"],
    );
    assert.equal(setupDivider(player), null);
  });

  test("no divider before a toolbar that starts with a setup tool, or has none", () => {
    assert.equal(setupDivider([{ id: "pin" }, { id: "select" }]), null);
    assert.equal(setupDivider([{ id: "select" }, { id: "ruler" }]), null);
    assert.equal(setupDivider([]), null);
    assert.deepEqual([...SETUP_TOOLS].sort(), ["add-token", "build", "grid", "pin", "trap"]);
  });
});

describe("the buttons a toolbar draws (docs/design/design-v1-tool-options.md 5.1)", () => {
  const dm = toolbar(["select", "add-token", "ruler", "area", "draw", "ping", "pin", "trap", "fog", "build", "grid"]);
  const player = toolbar(["select", "ruler", "area", "draw", "ping"]);

  test("on a phone the DM's setup tools stand behind Setup, after the divider", () => {
    assert.deepEqual(toolbarButtons(dm, false), { ids: ["select", "ruler", "area", "fog", "draw", "ping", SETUP_BUTTON], divider: 6 });
  });

  test("from 900 px up every tool shows, with the divider before the setup tools", () => {
    assert.deepEqual(toolbarButtons(dm, true), { ids: dm.map((t) => t.id), divider: 6 });
  });

  test("a player's toolbar is the same on every layout", () => {
    for (const wide of [false, true]) assert.deepEqual(toolbarButtons(player, wide), { ids: ["select", "ruler", "area", "draw", "ping"], divider: null });
  });
});

describe("Hidden tools, the way back to the tools of parts hidden on this device (docs/design/design-v1-features.md 6, D-261127-312)", () => {
  const dm = toolbar(["select", "add-token", "area", "draw", "ping", "fog", "build", "grid"]);
  const player = toolbar(["select", "area", "draw", "ping"]);

  test("from 900 px up one button after the last tool, for play and setup tools alike", () => {
    assert.deepEqual(toolbarButtons(dm, true, { play: 1, setup: 0 }).ids.at(-1), HIDDEN_TOOLS_BUTTON);
    assert.deepEqual(toolbarButtons(dm, true, { play: 0, setup: 2 }), { ids: [...dm.map((t) => t.id), HIDDEN_TOOLS_BUTTON], divider: 5 });
  });

  test("on a phone after the play tools for a play tool, and none for a setup tool, whose Show stands at the foot of Setup's menu", () => {
    assert.deepEqual(toolbarButtons(dm, false, { play: 1, setup: 2 }), { ids: ["select", "area", "fog", "draw", "ping", HIDDEN_TOOLS_BUTTON, SETUP_BUTTON], divider: 6 });
    assert.deepEqual(toolbarButtons(dm, false, { play: 0, setup: 2 }), toolbarButtons(dm, false), "Traps and Pins hidden: no Hidden tools button");
    assert.deepEqual(toolbarButtons(player, false, { play: 1, setup: 0 }), { ids: ["select", "area", "draw", "ping", HIDDEN_TOOLS_BUTTON], divider: null });
  });

  test("with nothing hidden it is never drawn", () => {
    for (const wide of [false, true]) for (const tools of [dm, player]) assert.ok(!toolbarButtons(tools, wide, { play: 0, setup: 0 }).ids.includes(HIDDEN_TOOLS_BUTTON));
  });
});
