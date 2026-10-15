import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { CHUNK_CELLS, type BuildChunk, type RoomState } from "#shared/model.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { room, scene } from "#shared/testutil.ts";
import { emptyTap } from "../../../canvas/emptyTap.ts";
import { RoomScope } from "../../../state/scope.ts";
import type { RoomUi } from "../../../state/store.ts";
import type { RoomActions, RoomView } from "../../../state/types.ts";
import { doorPillSlot } from "../../doors/store.ts";
import type { ToolContext } from "../../tools.ts";
import { builderSlot, labelPaneSlot } from "../store.ts";
import { readoutSlot } from "./store.ts";
import { tapGround } from "./tap.ts";

/**
 * A 12 by 8 scene at 40 px a cell: a platform 10 ft up over columns 2 to 4,
 * a second one 10 ft up at column 8, a door on the north edge of (6, 4), a
 * label-only pin on the platform at (3, 3), and a DM's label at (10, 6).
 */
function layout(): RoomState {
  const state = room();
  state.scenes.s1 = scene("s1", { bounds: { w: 12, h: 8 } });
  const feet = new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0);
  for (let y = 0; y < 8; y++) {
    for (const x of [2, 3, 4, 8]) feet[y * CHUNK_CELLS + x] = 10;
  }
  const chunk: BuildChunk = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: { "6,4,n": { kind: "door", state: "closed", secret: false, discovered: false } }, heights: encodeHeights(feet) };
  state.buildChunks["s1:0,0"] = chunk;
  state.pins.pin = { id: "pin", rev: 0, sceneId: "s1", x: 3.5, y: 3.5, color: "#f7df00", visibility: "all", label: "Old shrine" };
  state.labels.lbl = { id: "lbl", rev: 0, sceneId: "s1", x: 10.5, y: 6.5, text: "Crypt", size: 1 } as RoomState["labels"][string];
  return state;
}

let state: RoomState;
let ctx: ToolContext;
let deselected: number;
let frames: (() => void)[];
/** Every value the status line took, in order. */
let spoken: string[];

function contextFor(role: "dm" | "player"): ToolContext {
  return {
    actions: {} as RoomActions,
    ui: { select: () => {} } as unknown as RoomUi,
    getState: () => ({ view: state, local: { tool: "select", selectedId: null } }) as unknown as RoomView,
    scene: state.scenes.s1!,
    role,
    camera: () => ({ x: 0, y: 0, scale: 40 }),
    scope: new RoomScope(),
  };
}

beforeEach(() => {
  state = layout();
  ctx = contextFor("player");
  deselected = 0;
  frames = [];
  spoken = [];
  const slot = ctx.scope.get(readoutSlot);
  slot.nextFrame = (fn) => void frames.push(fn);
  slot.store.subscribe((s, prev) => {
    if (s.spoken !== prev.spoken) spoken.push(s.spoken);
  });
});

const readout = () => ctx.scope.get(readoutSlot).store.getState().readout;
const flush = () => frames.splice(0).forEach((fn) => fn());
const tap = (x: number, y: number, held = false) => emptyTap(ctx, "select", { x, y }, held, () => deselected++);

describe("the height readout's tap", () => {
  test("a tap that only deselects a token shows a reading of the ground under it", () => {
    tap(2.5, 5.5);
    flush();
    assert.equal(deselected, 1);
    assert.deepEqual(readout()?.cell, { x: 2, y: 5 });
    assert.deepEqual(spoken, ["Ground 10 ft up."]);
  });

  test("two taps on two areas at the same height set the status line twice, cleared between", () => {
    tap(2.5, 5.5);
    flush();
    tap(8.5, 5.5);
    flush();
    assert.deepEqual(spoken, ["Ground 10 ft up.", "", "Ground 10 ft up."]);
    assert.deepEqual(readout()?.cell, { x: 8, y: 5 });
  });

  test("a tap on a pin on raised ground leaves the pin its tap and shows no reading", () => {
    tap(2.5, 5.5);
    flush();
    // The pin's head is 14 px over its tip at (3.5, 3.5).
    assert.equal(tapGround(ctx, "select", { x: 3.5, y: 3.5 - 14 / 40 }), false);
    assert.equal(readout(), null, "the earlier reading goes with the tap");
    assert.deepEqual(spoken, ["Ground 10 ft up.", ""]);
  });

  test("a tap that closes the door pill shows no reading in its place", () => {
    ctx.scope.get(doorPillSlot).setState({ pill: { sceneId: "s1", ref: { edge: "6,4,n" } } });
    tap(2.5, 5.5);
    flush();
    assert.equal(ctx.scope.get(doorPillSlot).getState().pill, null);
    assert.equal(readout(), null);
    assert.deepEqual(spoken, []);
    // With the pill gone, the next tap there reads the ground.
    tap(2.5, 5.5);
    flush();
    assert.deepEqual(spoken, ["Ground 10 ft up."]);
  });

  test("a tap on a door opens its pill and puts a reading away", () => {
    tap(2.5, 5.5);
    flush();
    tap(6.5, 4);
    assert.deepEqual(ctx.scope.get(doorPillSlot).getState().pill, { sceneId: "s1", ref: { edge: "6,4,n" } });
    assert.equal(readout(), null);
  });

  test("a hold that pinged only deselects: no label, door or reading", (t) => {
    // A label is measured on a canvas, which Node lacks, so it falls back to its estimate.
    const g = globalThis as { document?: unknown };
    const had = "document" in g;
    g.document = { createElement: () => ({ getContext: () => null }) };
    t.after(() => {
      if (!had) delete g.document;
    });
    ctx = contextFor("dm");
    ctx.scope.get(readoutSlot).nextFrame = (fn) => void frames.push(fn);
    ctx.scope.get(builderSlot).store.setState({ mode: "paint" });
    tap(6.5, 4, true);
    tap(10.6, 6.5, true);
    tap(2.5, 5.5, true);
    flush();
    assert.equal(deselected, 3);
    assert.equal(ctx.scope.get(doorPillSlot).getState().pill, null);
    assert.equal(ctx.scope.get(labelPaneSlot).getState().labelId, null);
    assert.equal(readout(), null);
    // The same taps unheld: the door, then the DM's label, each take theirs.
    tap(6.5, 4);
    assert.ok(ctx.scope.get(doorPillSlot).getState().pill);
    tap(10.6, 6.5);
    assert.equal(ctx.scope.get(labelPaneSlot).getState().labelId, "lbl");
  });

  test("ground at 0, any other tool, and ground under a player's fog read nothing", () => {
    tap(0.5, 0.5);
    assert.equal(readout(), null);
    emptyTap(ctx, "ruler", { x: 2.5, y: 5.5 }, false, () => {});
    assert.equal(readout(), null);
    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
    ctx = { ...ctx, scene: state.scenes.s1 };
    tap(2.5, 5.5);
    flush();
    assert.equal(readout(), null);
    assert.deepEqual(spoken, []);
  });
});
