import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import type { RoomState, Scene, Stamp } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { RoomScope } from "../../../state/scope.ts";
import type { RoomUi } from "../../../state/store.ts";
import type { RoomActions, RoomView } from "../../../state/types.ts";
import type { ToolContext, ToolPointer } from "../../tools.ts";
import { builderSlot } from "../store.ts";
import { stampPointer, withStampMode } from "./pointer.ts";
import { ROTATE_HANDLE_PX } from "./rules.ts";
import { stampSlot } from "./store.ts";

const SCALE = 50;

function stamp(over: Partial<Stamp> = {}): Stamp {
  return { id: "s1", rev: 0, sceneId: "scene", art: { key: "barrel" }, x: 5, y: 5, w: 2, h: 1, rotation: 0, z: 3, visibility: "all", ...over };
}

let sent: ClientOp[];
let stamps: Record<string, Stamp>;
let ctx: ToolContext;
let ids: number;
let tool: string;
/** The click the browser sends after a tap, and the timers waiting on it, run by hand. */
let clicks: (() => void)[];
let timers: { fn: () => void; ms: number; off: boolean }[];

function click(): void {
  for (const listener of clicks.splice(0)) listener();
}

function runTimers(upTo: number): void {
  for (const t of timers.splice(0)) {
    if (t.off) continue;
    if (t.ms <= upTo) t.fn();
    else timers.push(t);
  }
}

beforeEach(() => {
  sent = [];
  tool = "build";
  clicks = [];
  timers = [];
  stamps = { s1: stamp() };
  ids = 0;
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
    getState: () => ({ view: { stamps } as unknown as RoomState, local: { tool } }) as unknown as RoomView,
    scene: { id: "scene", bounds: { w: 20, h: 12 } } as Scene,
    role: "dm",
    camera: () => ({ x: 0, y: 0, scale: SCALE }),
    scope: new RoomScope(),
  };
  ctx.scope.get(builderSlot).store.setState({ mode: "stamp" });
  ctx.scope.get(stampSlot).clickWait = {
    onNextClick(listener) {
      clicks.push(listener);
      return () => {
        clicks = clicks.filter((l) => l !== listener);
      };
    },
    later(fn, ms) {
      const t = { fn, ms, off: false };
      timers.push(t);
      return () => {
        t.off = true;
      };
    },
  };
});

function at(x: number, y: number): ToolPointer {
  return { world: { x, y }, screen: { x: x * SCALE, y: y * SCALE }, pointerId: 1, pointerType: "mouse", button: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, tokenId: null };
}

function gesture(...points: [number, number][]): void {
  const [first, ...rest] = points;
  assert.ok(first);
  stampPointer.down(at(...first), ctx);
  for (const p of rest) stampPointer.move(at(...p), ctx);
  stampPointer.up(at(...(rest[rest.length - 1] ?? first)), ctx);
}

const state = () => ctx.scope.get(stampSlot).store.getState();
const choose = () => ctx.scope.get(stampSlot).store.setState({ chosen: { art: { key: "chest" }, w: 0.75, h: 0.5, name: "Chest" } });

function onlyPut(): Stamp {
  assert.equal(sent.length, 1);
  const op = sent[0];
  assert.ok(op && op.t === "build.stamps" && op.put?.length === 1);
  return op.put[0] as unknown as Stamp;
}

describe("placing stamps", () => {
  test("a tap with nothing chosen opens the picker once the tap's click has gone by, and sends nothing", () => {
    gesture([12, 8]);
    assert.equal(sent.length, 0);
    assert.match(ctx.scope.get(builderSlot).store.getState().note ?? "", /Choose a stamp/);
    // On a phone the sheet would open under the finger, and the tap's click would pick a tile or close it.
    assert.equal(state().pickerOpen, false, "opened before the tap's click");
    click();
    assert.equal(state().pickerOpen, false, "opened while the click was still being handled");
    runTimers(0);
    assert.equal(state().pickerOpen, true);
    // The wait for a click that never came is called off, so nothing opens it a second time.
    ctx.scope.get(stampSlot).store.setState({ pickerOpen: false });
    runTimers(Infinity);
    assert.equal(state().pickerOpen, false);
  });

  test("a tap whose click never comes still opens the picker, and leaving Stamp mode first keeps it shut", () => {
    gesture([12, 8]);
    runTimers(499);
    assert.equal(state().pickerOpen, false);
    runTimers(500);
    assert.equal(state().pickerOpen, true);

    ctx.scope.get(stampSlot).store.setState({ pickerOpen: false });
    gesture([12, 8]);
    tool = "select";
    click();
    runTimers(Infinity);
    assert.equal(state().pickerOpen, false);
  });

  test("a tap places the chosen stamp snapped to half cells, on top, and selects it", () => {
    choose();
    gesture([12.2, 8.8]);
    const put = onlyPut();
    assert.deepEqual({ id: put.id, x: put.x, y: put.y, w: put.w, h: put.h, z: put.z, art: put.art }, { id: "new-1", x: 12, y: 9, w: 0.75, h: 0.5, z: 4, art: { key: "chest" } });
    assert.equal(state().selectedId, "new-1");
  });

  test("a drag across empty map places nothing", () => {
    choose();
    gesture([12, 8], [14, 9]);
    assert.equal(sent.length, 0);
  });

  test("a scene at 500 stamps says so instead of placing a 501st", () => {
    choose();
    for (let i = 0; i < 500; i++) stamps[`x${i}`] = stamp({ id: `x${i}`, x: 15, y: 10 });
    gesture([2, 2]);
    assert.equal(sent.length, 0);
    assert.match(ctx.scope.get(builderSlot).store.getState().note ?? "", /500 stamps/);
  });
});

describe("selecting and changing stamps", () => {
  test("a tap on a stamp selects it and sends nothing", () => {
    choose();
    gesture([5.5, 5.2]);
    assert.equal(sent.length, 0);
    assert.equal(state().selectedId, "s1");
  });

  test("a drag moves the stamp in half cells, as one op", () => {
    gesture([5, 5], [6, 5.4], [7.3, 6.2]);
    const put = onlyPut();
    assert.deepEqual([put.x, put.y], [7.5, 6]);
    assert.equal(put.rotation, 0);
    assert.equal(state().preview, null);
  });

  test("with Snap off a drag follows the pointer", () => {
    ctx.scope.get(stampSlot).store.setState({ snap: false });
    gesture([5, 5], [7.3, 6.2]);
    const put = onlyPut();
    assert.ok(Math.abs(put.x - 7.3) < 1e-9 && Math.abs(put.y - 6.2) < 1e-9);
  });

  test("the rotate handle turns the selected stamp in 15 degree steps", () => {
    ctx.scope.get(stampSlot).store.setState({ selectedId: "s1" });
    const handleY = 5 - 0.5 - ROTATE_HANDLE_PX / SCALE;
    gesture([5, handleY], [6, 4.1], [8, 5.1]);
    const put = onlyPut();
    assert.equal(put.rotation, 90);
    assert.deepEqual([put.x, put.y, put.w, put.h], [5, 5, 2, 1]);
  });

  test("the corner handle resizes the selected stamp about its center, keeping its shape", () => {
    ctx.scope.get(stampSlot).store.setState({ selectedId: "s1" });
    gesture([6.2, 5.7], [7.4, 6.4]);
    const put = onlyPut();
    assert.ok(Math.abs(put.w / put.h - 2) < 0.01, `${put.w} by ${put.h}`);
    assert.ok(put.w > 2.5);
    assert.deepEqual([put.x, put.y], [5, 5]);
  });

  test("a second finger cancels the gesture: nothing is sent and the preview goes", () => {
    stampPointer.down(at(5, 5), ctx);
    stampPointer.move(at(8, 8), ctx);
    assert.ok(state().preview);
    stampPointer.cancel(ctx);
    stampPointer.up(at(8, 8), ctx);
    assert.equal(sent.length, 0);
    assert.equal(state().preview, null);
  });

  test("a stamp undone or erased mid-drag is not put back", () => {
    stampPointer.down(at(5, 5), ctx);
    stampPointer.move(at(8, 8), ctx);
    delete stamps.s1;
    stampPointer.up(at(8, 8), ctx);
    assert.equal(sent.length, 0);
  });

  test("letting go where the stamp started sends nothing", () => {
    gesture([5, 5], [6, 6], [5.1, 5.1]);
    assert.equal(sent.length, 0);
  });
});

describe("the builder's other modes", () => {
  test("outside Stamp mode the builder's own handlers get the pointer", () => {
    const seen: string[] = [];
    const handlers = withStampMode({ down: () => seen.push("down"), move: () => seen.push("move"), up: () => seen.push("up") });
    ctx.scope.get(builderSlot).store.setState({ mode: "paint" });
    handlers.down?.(at(1, 1), ctx);
    handlers.move?.(at(2, 1), ctx);
    handlers.up?.(at(2, 1), ctx);
    assert.deepEqual(seen, ["down", "move", "up"]);
    ctx.scope.get(builderSlot).store.setState({ mode: "stamp" });
    choose();
    handlers.down?.(at(1, 1), ctx);
    handlers.up?.(at(1, 1), ctx);
    assert.deepEqual(seen, ["down", "move", "up"]);
    assert.equal(sent.length, 1);
  });
});
