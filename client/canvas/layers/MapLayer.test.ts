import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import Konva from "konva";
import { createStore } from "zustand/vanilla";
import type { BuildChunk, GridShape, Scene } from "#shared/model.ts";
import { member, room, scene } from "#shared/testutil.ts";

/*
 * Line up grid hides the app's own lines: while the DM's tool is open the
 * board draws neither the map layer's grid nor the builder's copy of it
 * over the floor, and both come back when it closes. The components render
 * through react-konva's own reconciler into a bare Konva group, so the test
 * reads the nodes the board would draw.
 */

// The builder's paths and textures use browser classes Node lacks. Neither is drawn here.
class NoPath {
  moveTo() {}
  lineTo() {}
  closePath() {}
  arc() {}
  rect() {}
}
Object.assign(globalThis, { Path2D: NoPath, Image: class { decode = () => new Promise(() => {}) } });

const { createElement } = await import("react");
const { KonvaRenderer } = await import("react-konva");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { MapContent } = await import("./MapLayer.tsx");
const { BuilderLayer } = await import("../../features/builder/BuilderLayer.tsx");

const GRID_COLOR = "#123456";
const CONCURRENT_ROOT = 1;

type Board = { root: Konva.Group; setTool(tool: string): void; dispatched: unknown[] };
const mounted: (() => void)[] = [];
afterEach(() => mounted.splice(0).forEach((unmount) => unmount()));

/** Renders `part` for a DM whose tool is `tool`, in a room holding `s` and a two-square floor. */
function board(s: Scene, tool: string, part: (s: Scene) => ReturnType<typeof createElement>): Board {
  const view = room({ members: { dm1: member("dm1", "dm") } });
  view.scenes[s.id] = s;
  const floor: BuildChunk = { sceneId: s.id, cx: 0, cy: 0, rev: 1, cells: { "1,1": "stone", "2,1": "stone" }, edges: {} };
  view.buildChunks = { floor };
  const store = createStore(() => ({ view, floorView: view, you: { memberId: "dm1", role: "dm" }, roomId: "r1", sceneId: s.id, connection: "open", pending: [], local: { tool, selectedIds: [], multi: false } }));
  const dispatched: unknown[] = [];
  const errors: unknown[] = [];
  const caught = (error: unknown) => void errors.push(error);
  const root = new Konva.Group();
  const container = KonvaRenderer.createContainer(root, CONCURRENT_ROOT, null, false, null, "", caught, caught, caught, () => {}, null);
  const actions = { dispatch: (op: unknown) => dispatched.push(op), newId: () => "x" };
  const tree = createElement(RoomProvider, {
    store: store as never,
    actions: actions as never,
    ui: {} as never,
    assets: { url: () => "" },
    children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: part(s) }),
  });
  KonvaRenderer.updateContainerSync(tree, container, null, null);
  KonvaRenderer.flushSyncWork();
  assert.deepEqual(errors, [], "the board threw as it rendered");
  mounted.push(() => {
    KonvaRenderer.updateContainerSync(null, container, null, null);
    KonvaRenderer.flushSyncWork();
  });
  return {
    root,
    dispatched,
    setTool(next) {
      store.setState((st) => ({ local: { ...st.local, tool: next } }));
      KonvaRenderer.flushSyncWork();
      assert.deepEqual(errors, [], "the board threw as the tool changed");
    },
  };
}

const lined = (gridShape?: GridShape) => scene("s1", { grid: { show: true, color: GRID_COLOR, opacity: 0.25, lineWidth: 1 }, ...(gridShape ? { gridShape } : {}) });
const mapContent = (s: Scene) => createElement(MapContent, { scene: s, variant: "full", report: false, video: false });
const builder = (s: Scene) => createElement(BuilderLayer, { scene: s, role: "dm", scale: 40 } as never);
const appLines = (b: Board) => b.root.find(".sceneGrid").length;

/** The stroke colors the builder's floor shape sets as it draws, on a context that only records them. */
function floorStrokes(b: Board): unknown[] {
  const shape = b.root.find("Shape").find((n) => n.name() === "");
  assert.ok(shape, "the builder drew no floor");
  const strokes: unknown[] = [];
  const answers: Record<string, unknown> = { measureText: () => ({ width: 1 }), createPattern: () => null };
  const g = new Proxy({} as Record<string | symbol, unknown>, {
    get: (own, key) => (key in own ? own[key] : typeof key === "string" && key in answers ? answers[key] : () => {}),
    set: (own, key, value) => {
      if (key === "strokeStyle") strokes.push(value);
      own[key] = value;
      return true;
    },
  });
  (shape as Konva.Shape).sceneFunc().call(shape, { _context: g } as never, shape as Konva.Shape);
  return strokes;
}

describe("Line up grid hides the app's own lines", () => {
  for (const gridShape of [undefined, "hexRows", "hexColumns"] as const) {
    test(`the map layer draws no grid while the tool is open, and the same grid once it closes (${gridShape ?? "squares"})`, () => {
      const s = lined(gridShape);
      const b = board(s, "select", mapContent);
      assert.equal(appLines(b), 1, "the scene's lines draw under another tool");
      b.setTool("grid");
      assert.equal(appLines(b), 0, "the app's lines drew over the art being lined up");
      b.setTool("select");
      assert.equal(appLines(b), 1, "the lines did not come back as the tool closed");
      assert.equal(s.grid.show, true, "the scene's Grid lines setting changed");
      assert.deepEqual(b.dispatched, [], "hiding the lines sent something");
    });
  }

  test("opened on the board, the tool hides the lines at once", () => {
    assert.equal(appLines(board(lined(), "grid", mapContent)), 0);
  });

  test("every other tool draws the lines as before", () => {
    for (const tool of ["ruler", "area", "draw", "ping", "add-token", "pin", "trap", "fog", "build"]) {
      assert.equal(appLines(board(lined(), tool, mapContent)), 1, tool);
    }
  });

  test("a scene with Grid lines off draws none under any tool", () => {
    const s = scene("s1", { grid: { show: false, color: GRID_COLOR, opacity: 0.25, lineWidth: 1 } });
    const b = board(s, "select", mapContent);
    assert.equal(appLines(b), 0);
    b.setTool("grid");
    assert.equal(appLines(b), 0);
  });

  test("the builder's copy of the grid over the floor goes too, and comes back", () => {
    const b = board(lined(), "select", builder);
    assert.ok(floorStrokes(b).includes(GRID_COLOR), "the floor's grid draws under another tool");
    b.setTool("grid");
    assert.ok(!floorStrokes(b).includes(GRID_COLOR), "the floor's grid drew while lining up");
    b.setTool("select");
    assert.ok(floorStrokes(b).includes(GRID_COLOR), "the floor's grid did not come back");
    assert.deepEqual(b.dispatched, []);
  });
});
