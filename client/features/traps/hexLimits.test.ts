import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HEX_LIMITS } from "../grid/words.ts";

const { trapTool, trapToolOff } = await import("./TrapTool.tsx");

/** A context that fails on any reach for the tool's state or the server: a hex scene's gestures must touch neither. */
function untouchable(gridShape?: "hexRows") {
  const boom = () => {
    throw new Error("the Trap tool reached past a hex scene's gate");
  };
  return { scene: { id: "s", gridShape, bounds: { w: 10, h: 10 } }, scope: { get: boom }, actions: { dispatch: boom, newId: boom }, ui: { notify: boom }, getState: boom, camera: boom } as never;
}
const pointer = { screen: { x: 1, y: 1 }, world: { x: 1, y: 1 } } as never;

describe("the Trap tool on a hex scene (H1)", () => {
  test("it says the trap limit and has nothing to place", () => {
    assert.equal(trapToolOff({ gridShape: "hexRows" }), HEX_LIMITS.trap);
    assert.equal(trapToolOff({ gridShape: "hexColumns" }), HEX_LIMITS.trap);
    assert.equal(trapToolOff({}), null);
  });
  test("its pointer handlers draw and send nothing", () => {
    const ctx = untouchable("hexRows");
    trapTool.pointer!.down!(pointer, ctx);
    trapTool.pointer!.move!(pointer, ctx);
    trapTool.pointer!.up!(pointer, ctx);
  });
  test("a square scene's handlers still reach for the tool's state", () => {
    assert.throws(() => trapTool.pointer!.down!(pointer, untouchable()), /past a hex scene's gate/);
  });
});
