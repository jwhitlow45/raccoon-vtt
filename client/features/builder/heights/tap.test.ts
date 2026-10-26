import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { CHUNK_CELLS, STAIRS_CHARS, type BuildChunk, type RoomState } from "#shared/model.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { room, scene } from "#shared/testutil.ts";
import { boardPickFor, boardPickSlot, DrawnHeightsMemo, pressAt, screenAt } from "../../../canvas/boardPick.ts";
import { emptyTap, putAway } from "../../../canvas/emptyTap.ts";
import { isometric } from "../../../lib/view.ts";
import { RoomScope } from "../../../state/scope.ts";
import type { RoomUi } from "../../../state/store.ts";
import type { RoomActions, RoomView } from "../../../state/types.ts";
import { doorPillSlot } from "../../doors/store.ts";
import { pinSlot } from "../../pins/store.ts";
import type { ToolContext } from "../../tools.ts";
import { builderSlot, labelPaneSlot } from "../store.ts";
import { followReadout, readoutSlot } from "./store.ts";
import { tapGround, wordsAt } from "./tap.ts";

/**
 * A 12 by 8 scene at 40 px a cell: a platform 10 ft up over columns 2 to 4,
 * a second one 10 ft up at column 8, a door on the north edge of (6, 4), a
 * stair pointing east at (6, 6), a label-only pin on the platform at (3, 3),
 * and a DM's label at (10, 6).
 */
function layout(): RoomState {
  const state = room();
  state.scenes.s1 = scene("s1", { bounds: { w: 12, h: 8 } });
  state.buildChunks["s1:0,0"] = chunkWith({ platform: 10, stair: "e" });
  state.pins.pin = { id: "pin", rev: 0, sceneId: "s1", x: 3.5, y: 3.5, color: "#f7df00", visibility: "all", label: "Old shrine" };
  state.labels.lbl = { id: "lbl", rev: 0, sceneId: "s1", x: 10.5, y: 6.5, text: "Crypt", size: 1 } as RoomState["labels"][string];
  return state;
}

/** The layout's one chunk, its platform at `platform` feet and its stair pointing `stair`. */
function chunkWith(input: { platform: number; stair: "n" | "e" | "s" | "w" }): BuildChunk {
  const feet = new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0);
  for (let y = 0; y < 8; y++) {
    for (const x of [2, 3, 4]) feet[y * CHUNK_CELLS + x] = input.platform;
    feet[y * CHUNK_CELLS + 8] = 10;
  }
  const up = ".".repeat(STAIRS_CHARS).split("");
  up[6 * CHUNK_CELLS + 6] = input.stair;
  return {
    sceneId: "s1",
    cx: 0,
    cy: 0,
    rev: 0,
    cells: {},
    edges: { "6,4,n": { kind: "door", state: "closed", secret: false, discovered: false } },
    heights: encodeHeights(feet),
    up: up.join(""),
  };
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

  test("one thing floats at a time both ways: a reading puts a pin's popover away, and a tap on the pin puts the reading away", () => {
    const popover = () => ctx.scope.get(pinSlot).store.getState().popover;
    const pinHead = { x: 3.5, y: 3.5 - 14 / 40 };
    // The pin layer opens the popover on its own tap, and the same tap reaches the canvas, which leaves it be.
    ctx.scope.get(pinSlot).store.setState({ popover: { id: "pin", at: 0 } });
    tap(pinHead.x, pinHead.y);
    assert.ok(popover(), "the pin's own tap closed its popover");
    tap(2.5, 5.5);
    flush();
    assert.equal(popover(), null);
    assert.deepEqual(readout()?.cell, { x: 2, y: 5 });
    tap(pinHead.x, pinHead.y);
    assert.equal(readout(), null);
    // A tap that only puts the popover away, on ground at 0, or one a door takes, closes it too.
    ctx.scope.get(pinSlot).store.setState({ popover: { id: "pin", at: 0 } });
    tap(0.5, 0.5);
    assert.equal(popover(), null);
    ctx.scope.get(pinSlot).store.setState({ popover: { id: "pin", at: 0 } });
    tap(6.5, 4);
    assert.equal(popover(), null);
    assert.ok(ctx.scope.get(doorPillSlot).getState().pill);
    // A hold that pinged is no tap, and leaves the popover up.
    ctx.scope.get(pinSlot).store.setState({ popover: { id: "pin", at: 0 } });
    tap(2.5, 5.5, true);
    assert.ok(popover());
  });

  test("in Isometric a pin keeps its tap where it stands on the 10 ft platform, and a press where it would lie at 0 reads the ground", () => {
    const pick = boardPickFor({ room: state, scene: state.scenes.s1!, role: "player", fog: false, view: isometric(0), camera: { x: 300, y: 100, scale: 40 }, lowPower: false }, new DrawnHeightsMemo());
    ctx.scope.get(boardPickSlot).read = () => pick;
    const popover = () => ctx.scope.get(pinSlot).store.getState().popover;
    // The pin's head is 14 px over its tip, which stands at the platform's top.
    const tip = screenAt(pick, { x: 3.5, y: 3.5 }, 2);
    const head = { x: tip.x, y: tip.y - 14 };
    ctx.scope.get(pinSlot).store.setState({ popover: { id: "pin", at: 0 } });
    putAway(ctx, pressAt(pick, head), { readout: true, screen: head });
    assert.ok(popover(), "the pin's own tap leaves its popover up");
    assert.equal(tapGround(ctx, "select", pressAt(pick, head), head), false);
    const flat = screenAt(pick, { x: 3.5, y: 3.5 }, 0);
    const flatHead = { x: flat.x, y: flat.y - 14 };
    assert.equal(tapGround(ctx, "select", pressAt(pick, flatHead), flatHead), true);
  });

  test("Multi-select's tap off puts floaters away and opens nothing, and keeps a popover its own pin opened", () => {
    const popover = () => ctx.scope.get(pinSlot).store.getState().popover;
    const pinHead = { x: 3.5, y: 3.5 - 14 / 40 };
    ctx.scope.get(pinSlot).store.setState({ popover: { id: "pin", at: 0 } });
    putAway(ctx, pinHead);
    assert.ok(popover(), "the pin's own tap closed its popover");
    tap(2.5, 5.5);
    flush();
    assert.ok(readout());
    ctx.scope.get(pinSlot).store.setState({ popover: { id: "pin", at: 0 } });
    putAway(ctx, { x: 6.5, y: 4 });
    flush();
    assert.equal(popover(), null);
    assert.equal(readout(), null);
    assert.equal(ctx.scope.get(doorPillSlot).getState().pill, null, "a box tap opens no door");
    assert.equal(deselected, 1, "the helper lets go of nothing itself");
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

  test("a hold that pinged does nothing: it keeps the selection and opens no label, door or reading", (t) => {
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
    assert.equal(deselected, 0, "a ping neither lets go nor hides the bar");
    assert.equal(ctx.scope.get(doorPillSlot).getState().pill, null);
    assert.equal(ctx.scope.get(labelPaneSlot).getState().labelId, null);
    assert.equal(readout(), null);
    // The same taps unheld: the door, then the DM's label, each take theirs.
    tap(6.5, 4);
    assert.ok(ctx.scope.get(doorPillSlot).getState().pill);
    tap(10.6, 6.5);
    assert.equal(ctx.scope.get(labelPaneSlot).getState().labelId, "lbl");
  });

  /** A change to the build arrives as a new chunk collection, as the store hands the view one (walls.ts caches by it). */
  function repaint(input: Parameters<typeof chunkWith>[0]) {
    state.buildChunks = { ...state.buildChunks, "s1:0,0": chunkWith(input) };
  }

  /** What ReadoutHost does on each render: keeps the readout's words on what its pill says now. */
  function follow() {
    const r = ctx.scope.get(readoutSlot).store.getState().readout;
    const words = r ? wordsAt(state, ctx.scene, ctx.role, r.cell) : null;
    if (words) followReadout(ctx.scope.get(readoutSlot), words.spoken);
  }

  test("a repaint under an open readout changes what the status line says, as it changes the pill", () => {
    tap(2.5, 5.5);
    flush();
    repaint({ platform: -10, stair: "e" });
    follow();
    assert.deepEqual(spoken, ["Ground 10 ft up.", "Ground 10 ft down."]);
    follow();
    assert.deepEqual(spoken, ["Ground 10 ft up.", "Ground 10 ft down."], "no change, nothing said again");
  });

  test("a stair turned under an open readout says its new way up", () => {
    tap(6.5, 6.5);
    flush();
    repaint({ platform: 10, stair: "n" });
    follow();
    assert.deepEqual(spoken, ["Stairs, up to the east.", "Stairs, up to the north."]);
  });

  test("a repaint before the readout's first frame is said by that frame, and a repeated tap is still cleared first", () => {
    tap(2.5, 5.5);
    repaint({ platform: 15, stair: "e" });
    follow();
    assert.deepEqual(spoken, []);
    flush();
    assert.deepEqual(spoken, ["Ground 15 ft up."]);
    tap(2.5, 5.5);
    follow();
    flush();
    assert.deepEqual(spoken, ["Ground 15 ft up.", "", "Ground 15 ft up."]);
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
