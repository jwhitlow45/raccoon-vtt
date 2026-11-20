import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { LIMITS } from "#shared/limits.ts";
import type { FloorLink, RoomState } from "#shared/model.ts";
import { GROUND, UPPER, run, tower, withOpening, withStairs } from "#shared/floorLinksTestutil.ts";
import { LINK_WORDS } from "#shared/rules/floorLinks.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { hexCenter, type HexGrid } from "#shared/rules/hex.ts";
import { RoomScope } from "../../state/scope.ts";
import type { RoomUi } from "../../state/store.ts";
import type { RoomActions, RoomView } from "../../state/types.ts";
import type { ToolContext, ToolPointer } from "../tools.ts";
import { changePatch, farCenter, handleOf, HANDLE_PX, isNoChange, judgeChange, moveChange, onHandle, resizeChange, withLinkMode } from "./linkTap.ts";
import { builderSlot, linkPaneSlot } from "./store.ts";

/*
 * Moving and resizing an end in Between floors (docs/design/design-v1-floors.md
 * phase 4, 8.2): a press on an end and a drag moves this floor's end (an
 * opening moves both), the corner handle resizes both, and each draft is
 * judged in the words the server refuses it in.
 */

const BOUNDS = { w: 20, h: 20 };
const end = (state: RoomState, id: string): FloorLink => state.floorLinks![id]!;
const mid = (x: number, y: number) => ({ x: x + 0.5, y: y + 0.5 });

describe("a drag of an end's body", () => {
  test("moves this floor's end by the whole squares the pointer moved, and nothing else of it", () => {
    const state = withStairs(tower(), { rect: { x: 3, y: 3, w: 2, h: 1 } });
    const change = moveChange(SQUARES, end(state, "l1"), BOUNDS, mid(4, 3), mid(7, 5));
    assert.deepEqual(change, { rect: { x: 6, y: 5, w: 2, h: 1 } });
    assert.deepEqual(changePatch(change), { rect: { x: 6, y: 5, w: 2, h: 1 } });
  });

  test("squares of stairs may lie apart on the two floors, so a move of one end passes", () => {
    const state = withStairs();
    assert.equal(judgeChange(state, end(state, "l1"), { rect: { x: 8, y: 8, w: 2, h: 1 } }), null);
  });

  test("an opening's move writes one rect, which the server gives to both ends", () => {
    const state = withOpening(tower(), { rect: { x: 6, y: 6, w: 2, h: 2 } });
    const change = moveChange(SQUARES, end(state, "o1"), BOUNDS, mid(6, 6), mid(8, 6));
    assert.deepEqual(change, { rect: { x: 8, y: 6, w: 2, h: 2 } });
    assert.equal(judgeChange(state, end(state, "o1"), change), null);
  });

  test("onto a wall, past the floor's edge or over another end reads the new squares' own words", () => {
    const base = withStairs(tower(), { rect: { x: 3, y: 3, w: 2, h: 1 } });
    assert.equal(judgeChange(base, end(base, "l1"), { rect: { x: 19, y: 3, w: 2, h: 1 } }), LINK_WORDS.pastEdge("Ground floor"));
    const two = withStairs(base, { id: "l3", pairId: "l4", rect: { x: 10, y: 10, w: 2, h: 1 } });
    assert.equal(judgeChange(two, end(two, "l1"), { rect: { x: 10, y: 10, w: 2, h: 1 } }), LINK_WORDS.overEnd("stairs", "Upper floor"));
  });

  test("onto a wall inside the new squares is refused in the wall's words for the floor it is on", () => {
    const state = run(withStairs(), { t: "build.edge", sceneId: GROUND, edges: [{ key: "8,3,w", feature: { kind: "wall" } }] });
    assert.equal(judgeChange(state, end(state, "l1"), { rect: { x: 7, y: 3, w: 2, h: 1 } }), LINK_WORDS.wall("Ground floor"));
    assert.equal(judgeChange(state, end(state, "l1"), { rect: { x: 9, y: 3, w: 2, h: 1 } }), null);
  });

  test("stairs on squares keep both ends one size, so a rect of another size alone is refused", () => {
    const state = withStairs();
    assert.equal(judgeChange(state, end(state, "l1"), { rect: { x: 3, y: 3, w: 3, h: 1 } }), LINK_WORDS.oneSize("stairs"));
    assert.equal(judgeChange(state, end(state, "l1"), { rect: { x: 3, y: 3, w: 3, h: 1 }, pairRect: { x: 3, y: 3, w: 3, h: 1 } }), null);
  });

  test("a scene at its 16 pairs still moves one of them, which counts once", () => {
    let state = tower();
    for (let i = 0; i < LIMITS.floorLinksPerScene; i++) state = withStairs(state, { id: `a${i}`, pairId: `b${i}`, rect: { x: (i % 8) * 2, y: Math.floor(i / 8) * 2, w: 1, h: 1 } });
    assert.equal(judgeChange(state, end(state, "a0"), { rect: { x: 0, y: 6, w: 1, h: 1 } }), null);
  });

  test("an end's own squares and its pair's are no obstacle to it, whichever way it moves", () => {
    const state = withStairs(tower(), { rect: { x: 3, y: 3, w: 2, h: 1 } });
    assert.equal(judgeChange(state, end(state, "l1"), { rect: { x: 4, y: 3, w: 2, h: 1 } }), null);
    assert.equal(judgeChange(state, end(state, "l2"), { rect: { x: 4, y: 3, w: 2, h: 1 } }), null);
  });

  test("hex stairs moved on one floor are refused in the rules' words, and an opening on hexes moves whole", () => {
    const state = withStairs();
    const hex = { ...state, floorLinks: Object.fromEntries(Object.entries(state.floorLinks!).map(([id, l]) => [id, { ...l, grid: "hexRows" as const }])) } as RoomState;
    assert.equal(judgeChange(hex, end(hex, "l1"), { rect: { x: 5, y: 3, w: 2, h: 1 } }), LINK_WORDS.sameSquares("stairs"));
    assert.equal(judgeChange(hex, end(hex, "l1"), { rect: { x: 5, y: 3, w: 2, h: 1 }, pairRect: { x: 5, y: 3, w: 2, h: 1 } }), null);
  });

  test("on hexes the move counts hexes by the hex under each point", () => {
    const rows: HexGrid = { shape: "hex", orient: "rows" };
    const at = (col: number, row: number) => hexCenter(rows, { col, row });
    const state = withStairs(tower(), { rect: { x: 3, y: 4, w: 2, h: 1 } });
    assert.deepEqual(moveChange(rows, end(state, "l1"), BOUNDS, at(3, 4), at(6, 6)).rect, { x: 6, y: 6, w: 2, h: 1 });
  });

  test("no change when the squares are the end's own", () => {
    const state = withStairs();
    assert.equal(isNoChange(state, end(state, "l1"), { rect: { x: 3, y: 3, w: 2, h: 1 } }), true);
    assert.equal(isNoChange(state, end(state, "l1"), { rect: { x: 3, y: 3, w: 2, h: 1 }, pairRect: { x: 3, y: 3, w: 2, h: 1 } }), true);
    assert.equal(isNoChange(state, end(state, "l1"), { rect: { x: 4, y: 3, w: 2, h: 1 } }), false);
  });
});

describe("a drag of the corner handle", () => {
  const stairs = () => withStairs(tower(), { rect: { x: 3, y: 3, w: 2, h: 1 } });

  test("sizes both ends so the far square is the one under the pointer, each keeping its corner", () => {
    const base = stairs();
    const state = { ...base, floorLinks: { ...base.floorLinks, l2: { ...base.floorLinks!.l2!, rect: { x: 8, y: 8, w: 2, h: 1 } } } } as RoomState;
    const l1 = end(state, "l1");
    const far = farCenter(SQUARES, l1.rect);
    assert.deepEqual(far, { x: 4.5, y: 3.5 });
    const change = resizeChange(SQUARES, l1, end(state, "l2"), BOUNDS, far, { x: 5.5, y: 4.5 }, { x: 6.5, y: 5.5 });
    assert.deepEqual(change, { rect: { x: 3, y: 3, w: 3, h: 2 }, pairRect: { x: 8, y: 8, w: 3, h: 2 } });
    assert.equal(judgeChange(state, l1, change), null);
  });

  test("stairs hold to the stairs' side and an opening to its own, and neither goes below one square", () => {
    const state = stairs();
    const l1 = end(state, "l1");
    const wide = resizeChange(SQUARES, l1, end(state, "l2"), BOUNDS, farCenter(SQUARES, l1.rect), mid(0, 0), mid(15, 15));
    assert.deepEqual([wide.rect.w, wide.rect.h], [LIMITS.floorLinkSide, LIMITS.floorLinkSide]);
    const small = resizeChange(SQUARES, l1, end(state, "l2"), BOUNDS, farCenter(SQUARES, l1.rect), mid(5, 5), mid(0, 0));
    assert.deepEqual([small.rect.w, small.rect.h], [1, 1]);
    const open = withOpening(tower(), { rect: { x: 2, y: 2, w: 2, h: 2 } });
    const o1 = end(open, "o1");
    const big = resizeChange(SQUARES, o1, end(open, "o2"), BOUNDS, farCenter(SQUARES, o1.rect), mid(0, 0), mid(15, 15));
    assert.deepEqual(big, { rect: { x: 2, y: 2, w: LIMITS.openingSide, h: LIMITS.openingSide } });
    assert.equal(judgeChange(open, o1, big), null);
  });

  test("a press on the handle with no drag moves the far square by nothing", () => {
    const state = stairs();
    const l1 = end(state, "l1");
    const far = farCenter(SQUARES, l1.rect);
    assert.deepEqual(resizeChange(SQUARES, l1, end(state, "l2"), BOUNDS, far, mid(6, 4), mid(6, 4)).rect, l1.rect);
  });

  test("the handle's hit square is 44 px across, just outside the end's bottom right corner and never over its squares", () => {
    const scale = 44;
    const h = handleOf(SQUARES, { x: 3, y: 3, w: 2, h: 1 }, scale)!;
    assert.equal(h.r * 2 * scale, HANDLE_PX);
    assert.deepEqual([h.x - h.r, h.y - h.r], [5, 4]);
    assert.equal(onHandle(h, { x: 5.2, y: 4.2 }), true);
    assert.equal(onHandle(h, { x: 4.9, y: 3.9 }), false, "inside the end it is the end's body");
    assert.equal(onHandle(h, { x: 6.1, y: 4.5 }), false);
    assert.equal(onHandle(null, { x: 5.2, y: 4.2 }), false);
  });
});

describe("the gestures", () => {
  const SCALE = 50;
  const sent: unknown[] = [];
  let answer: (() => void) | null = null;
  let ctx: ToolContext;
  let state: RoomState;
  const pointer = withLinkMode({});
  const at = (x: number, y: number): ToolPointer => ({ screen: { x: x * SCALE, y: y * SCALE }, world: { x, y } }) as ToolPointer;

  function setup(from: RoomState): void {
    state = from;
    sent.length = 0;
    answer = null;
    ctx = {
      actions: {
        dispatch: (op: unknown, opts?: { onAnswer?: () => void }) => {
          sent.push(op);
          answer = opts?.onAnswer ?? null;
          return sent.length;
        },
        newId: () => "n",
      } as unknown as RoomActions,
      ui: { select: () => undefined } as unknown as RoomUi,
      getState: () => ({ view: state }) as unknown as RoomView,
      scene: state.scenes[GROUND]!,
      role: "dm",
      camera: () => ({ x: 0, y: 0, scale: SCALE }),
      scope: new RoomScope(),
    };
    ctx.scope.get(builderSlot).store.setState({ mode: "link", linkTo: UPPER });
  }
  const drag = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    pointer.down?.(at(from.x, from.y), ctx);
    pointer.move?.(at((from.x + to.x) / 2, (from.y + to.y) / 2), ctx);
    pointer.move?.(at(to.x, to.y), ctx);
  };
  const store = () => ctx.scope.get(builderSlot).store;
  const paneOf = () => ctx.scope.get(linkPaneSlot).getState().linkId;

  beforeEach(() => setup(withStairs(tower(), { rect: { x: 3, y: 3, w: 2, h: 1 } })));

  test("a press on an end and a drag shows the moved squares as the draft, and the lift sends one update of this end's rect", () => {
    drag(mid(3, 3), mid(7, 6));
    assert.deepEqual(store().getState().linkDraft, { rect: { x: 7, y: 6, w: 2, h: 1 }, problem: null });
    pointer.up?.(at(7.5, 6.5), ctx);
    assert.deepEqual(sent, [{ t: "floorLink.update", linkId: "l1", patch: { rect: { x: 7, y: 6, w: 2, h: 1 } } }]);
    assert.equal(paneOf(), "l1", "the moved end's pane opens, with its handle");
    assert.notEqual(store().getState().linkDraft, null, "the draft shows until the server answers");
    answer?.();
    assert.equal(store().getState().linkDraft, null);
  });

  test("a drag the rules refuse shows red with the reason and sends nothing", () => {
    drag(mid(3, 3), mid(19, 3));
    assert.deepEqual(store().getState().linkDraft, { rect: { x: 19, y: 3, w: 2, h: 1 }, problem: LINK_WORDS.pastEdge("Ground floor") });
    pointer.up?.(at(19.5, 3.5), ctx);
    assert.deepEqual(sent, []);
    assert.equal(store().getState().note, LINK_WORDS.pastEdge("Ground floor"));
  });

  test("a tap on an end opens its pane and moves nothing, and a drag back to its own squares sends nothing", () => {
    pointer.down?.(at(3.5, 3.5), ctx);
    pointer.up?.(at(3.5, 3.5), ctx);
    assert.equal(paneOf(), "l1");
    assert.deepEqual(sent, []);
    ctx.scope.get(linkPaneSlot).setState({ linkId: null });
    drag(mid(3, 3), mid(9, 9));
    pointer.move?.(at(3.5, 3.5), ctx);
    pointer.up?.(at(3.5, 3.5), ctx);
    assert.deepEqual(sent, []);
  });

  test("with the pane open, a press on the handle and a drag resizes both ends, and a press elsewhere on the end still moves it", () => {
    ctx.scope.get(linkPaneSlot).setState({ linkId: "l1" });
    const h = handleOf(SQUARES, { x: 3, y: 3, w: 2, h: 1 }, SCALE)!;
    drag({ x: h.x, y: h.y }, { x: h.x + 2, y: h.y + 1 });
    assert.deepEqual(store().getState().linkDraft, { rect: { x: 3, y: 3, w: 4, h: 2 }, problem: null });
    pointer.up?.(at(h.x + 2, h.y + 1), ctx);
    assert.deepEqual(sent, [{ t: "floorLink.update", linkId: "l1", patch: { rect: { x: 3, y: 3, w: 4, h: 2 }, pairRect: { x: 3, y: 3, w: 4, h: 2 } } }]);

    setup(withStairs(tower(), { rect: { x: 3, y: 3, w: 2, h: 1 } }));
    ctx.scope.get(linkPaneSlot).setState({ linkId: "l1" });
    drag(mid(3, 3), mid(5, 3));
    assert.deepEqual(store().getState().linkDraft?.rect, { x: 5, y: 3, w: 2, h: 1 }, "the body moves");
  });

  test("the handle is only of the end whose pane is open, on this floor", () => {
    const h = handleOf(SQUARES, { x: 3, y: 3, w: 2, h: 1 }, SCALE)!;
    drag({ x: h.x, y: h.y }, { x: h.x + 2, y: h.y + 1 });
    assert.deepEqual(store().getState().linkDraft?.rect, { x: 5, y: 4, w: 3, h: 2 }, "with no pane open the press is on empty squares, so the drag draws a new draft");
  });

  test("an opening dragged sends its rect alone", () => {
    setup(withOpening(tower(), { rect: { x: 6, y: 6, w: 2, h: 2 }, lower: GROUND, upper: UPPER }));
    ctx = { ...ctx, scene: state.scenes[GROUND]!, scope: ctx.scope };
    ctx.scope.get(builderSlot).store.setState({ mode: "link", linkTo: UPPER });
    drag(mid(6, 6), mid(9, 6));
    pointer.up?.(at(9.5, 6.5), ctx);
    assert.deepEqual(sent, [{ t: "floorLink.update", linkId: "o2", patch: { rect: { x: 9, y: 6, w: 2, h: 2 } } }]);
  });
});
