import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { LIMITS } from "#shared/limits.ts";
import type { Light, RoomState, Scene } from "#shared/model.ts";
import { clientOpSchema, type ClientOp } from "#shared/protocol.ts";
import { RoomScope } from "../../state/scope.ts";
import type { RoomUi } from "../../state/store.ts";
import type { RoomActions, RoomView } from "../../state/types.ts";
import { lightSlot } from "../builder/lightTap.ts";
import { builderSlot } from "../builder/store.ts";
import type { ToolContext, ToolPointer, ToolPointerHandlers } from "../tools.ts";
import { withLightMode } from "./pointer.ts";
import { cleanLabel, inputOf, lightSpot, patched, placedLight } from "./rules.ts";
import { lightModeSlot } from "./store.ts";

const SCALE = 50;

function light(over: Partial<Light> = {}): Light {
  return { id: "l1", rev: 2, sceneId: "scene", x: 5, y: 5, bright: 20, dim: 20, on: true, walls: true, label: "Torch", ...over };
}

let sent: ClientOp[];
let lights: Record<string, Light>;
let ctx: ToolContext;
let ids: number;
let inner: string[];
let pointer: ToolPointerHandlers;

beforeEach(() => {
  sent = [];
  lights = { l1: light() };
  ids = 0;
  inner = [];
  const actions = {
    dispatch(op: ClientOp) {
      sent.push(op);
      return sent.length;
    },
    newId: () => `new-${++ids}`,
  } as unknown as RoomActions;
  ctx = {
    actions,
    ui: {} as RoomUi,
    getState: () => ({ view: { lights } as unknown as RoomState, local: { tool: "build" } }) as unknown as RoomView,
    scene: { id: "scene", bounds: { w: 20, h: 12 } } as Scene,
    role: "dm",
    camera: () => ({ x: 0, y: 0, scale: SCALE }),
    scope: new RoomScope(),
  };
  ctx.scope.get(builderSlot).store.setState({ mode: "light" });
  pointer = withLightMode({
    down: () => inner.push("down"),
    move: () => inner.push("move"),
    up: () => inner.push("up"),
  });
});

function at(x: number, y: number): ToolPointer {
  return {
    world: { x, y },
    screen: { x: x * SCALE, y: y * SCALE },
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    tokenId: null,
  };
}

function tap(x: number, y: number): void {
  pointer.down?.(at(x, y), ctx);
  pointer.up?.(at(x, y), ctx);
}

const selected = () => ctx.scope.get(lightSlot).getState();
const paneOpen = () => ctx.scope.get(lightModeSlot).store.getState().paneOpen;

describe("the builder's Light mode", () => {
  test("a tap on empty map places the chosen preset there, on the lattice, and selects it", () => {
    ctx.scope.get(lightModeSlot).store.setState({ preset: "Lamp" });
    tap(2.1234, 3.5);
    assert.equal(sent.length, 1);
    const op = sent[0]!;
    assert.equal(op.t, "build.lights");
    assert.deepEqual(op.t === "build.lights" ? op.put : null, [{ id: "new-1", x: 136 / 64, y: 3.5, bright: 15, dim: 30, on: true, walls: true, label: "Lamp" }]);
    // The protocol takes it as it is.
    assert.equal(clientOpSchema.safeParse(op).success, true);
    assert.equal(selected().lightId, "new-1");
    assert.equal(paneOpen(), false, "placing does not open the pane");
    assert.deepEqual(inner, [], "the builder's own handlers never see Light mode's gestures");
  });

  test("a tap on a light opens its pane, and a tap away closes it rather than placing a light", () => {
    tap(5.2, 5.1);
    assert.equal(selected().lightId, "l1");
    assert.equal(paneOpen(), true);
    assert.equal(sent.length, 0);
    tap(12, 8);
    assert.equal(paneOpen(), false);
    assert.equal(selected().lightId, null);
    assert.equal(sent.length, 0);
    tap(12, 8);
    assert.equal(sent.length, 1, "with the pane shut, the next tap places");
  });

  test("a drag moves the light: it follows the finger, and one op is sent when let go", () => {
    pointer.down?.(at(5, 5), ctx);
    pointer.move?.(at(5.05, 5), ctx);
    assert.equal(selected().dragTo, null, "inside a tap's slop it has not moved yet");
    pointer.move?.(at(7.3, 6.01), ctx);
    assert.deepEqual(selected().dragTo, lightSpot({ x: 7.3, y: 6.01 }, { w: 20, h: 12 }));
    pointer.up?.(at(7.3, 6.01), ctx);
    assert.equal(selected().dragTo, null);
    assert.equal(sent.length, 1);
    const op = sent[0]!;
    assert.ok(op.t === "build.lights");
    assert.deepEqual(op.put, [{ ...inputOf(light()), ...lightSpot({ x: 7.3, y: 6.01 }, { w: 20, h: 12 }) }]);
    assert.equal(clientOpSchema.safeParse(op).success, true);
    assert.equal(paneOpen(), false, "a drag does not open the pane");
  });

  test("a light dragged off the scene stays at its edge, and a second finger sends nothing", () => {
    pointer.down?.(at(5, 5), ctx);
    pointer.move?.(at(-3, 30), ctx);
    assert.deepEqual(selected().dragTo, { x: 0, y: 12 });
    pointer.cancel?.(ctx);
    assert.equal(selected().dragTo, null);
    pointer.up?.(at(-3, 30), ctx);
    assert.equal(sent.length, 0);
  });

  test("a light undone while pressed is left alone", () => {
    pointer.down?.(at(5, 5), ctx);
    pointer.move?.(at(8, 8), ctx);
    lights = {};
    pointer.up?.(at(8, 8), ctx);
    assert.equal(sent.length, 0);
  });

  test("a full scene places no more lights and says so", () => {
    lights = {};
    for (let i = 0; i < LIMITS.lightsPerScene; i++) lights[`l${i}`] = light({ id: `l${i}`, x: 19, y: 11 });
    tap(1, 1);
    assert.equal(sent.length, 0);
    assert.equal(ctx.scope.get(builderSlot).store.getState().note, `This scene already has ${LIMITS.lightsPerScene} lights, the most it can hold.`);
  });

  test("other modes go to the builder's own handlers", () => {
    ctx.scope.get(builderSlot).store.setState({ mode: "paint" });
    tap(5, 5);
    assert.deepEqual(inner, ["down", "up"]);
    assert.equal(sent.length, 0);
  });
});

describe("light rules", () => {
  test("a stored light becomes an input, and a patch drops an empty label", () => {
    assert.deepEqual(inputOf(light()), { id: "l1", x: 5, y: 5, bright: 20, dim: 20, on: true, walls: true, label: "Torch" });
    assert.equal("label" in patched(light(), { label: undefined }), false);
    assert.deepEqual(patched(light(), { on: false }).on, false);
    assert.deepEqual(placedLight("a", { x: 1, y: 2 }, { name: "Daylight", bright: 60, dim: 60 }).label, "Daylight");
  });

  test("labels are one trimmed line", () => {
    assert.equal(cleanLabel("  Brazier \n by the door "), "Brazier   by the door");
    assert.equal(cleanLabel("   "), undefined);
    assert.equal(cleanLabel("a\u202eb"), "a b");
  });
});
