import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { token } from "#shared/testutil.ts";
import { boardPickFor, DrawnHeightsMemo, groundIn, ringCenter, type BoardPick } from "../../canvas/boardPick.ts";
import { fitSlot } from "../../canvas/fitSlot.ts";
import { NO_INSETS, viewToScreen, type Camera, type Insets, type Size } from "../../lib/camera.ts";
import { isometric, toView } from "../../lib/view.ts";
import { RoomScope } from "../../state/scope.ts";
import { raised, world } from "../movement/testing.ts";
import type { OutlineRow } from "./rows.ts";

const { focusOutlineRow } = await import("./focus.ts");

const viewport = { width: 800, height: 600 };
const bars = { top: 56, right: 0, bottom: 64, left: 0 };

/** The camera a tap on a row asks the canvas for, as the canvas works it out from this pick. */
function framed(row: OutlineRow, tokens: Record<string, ReturnType<typeof token>>, pick: BoardPick): Camera {
  const scope = new RoomScope();
  let asked: ((viewport: Size, bars: Insets, bar: Insets, pick: BoardPick) => Camera) | null = null;
  scope.get(fitSlot).show = (camera) => {
    asked = camera;
  };
  const ui = { setTool: () => {}, select: () => {}, showActions: () => {} };
  focusOutlineRow(row, { scope, ui: ui as never, actions: {} as never, sceneId: "s1", tokens });
  assert.ok(asked);
  return (asked as (viewport: Size, bars: Insets, bar: Insets, pick: BoardPick) => Camera)(viewport, bars, NO_INSETS, pick);
}

const row = (kind: OutlineRow["kind"], id: string, rect: OutlineRow["rect"]) => ({ key: `${kind}:${id}`, group: "creatures", kind, id, name: id, detail: "", mark: null, rect }) as unknown as OutlineRow;

test("an outline row for a 100 ft flier frames its ring where it draws, not its ground (ISO34-ASTRA-2)", () => {
  const state = world({});
  const roc = token("roc", { x: 20, y: 4, elevation: 100 });
  for (const turn of [0, 1, 2, 3] as const) {
    const pick = boardPickFor({ room: state, scene: state.scenes.s1!, role: "dm", fog: false, view: isometric(turn), camera: { x: 0, y: 0, scale: 40 }, lowPower: false, canvasHeight: 600 }, new DrawnHeightsMemo());
    const cam = framed(row("token", "roc", { x: 20, y: 4, width: 1, height: 1 }), { roc }, pick);
    const ring = ringCenter({ ...pick, camera: cam }, roc);
    assert.ok(Math.abs(ring.x - 400) < 1e-6 && Math.abs(ring.y - (56 + (600 - 120) / 2)) < 1e-6, `turn ${turn}: ${JSON.stringify(ring)}`);
  }
});

test("an outline row for anything else frames its box's middle at the ground under it", () => {
  const state = world({});
  const pick = boardPickFor({ room: state, scene: state.scenes.s1!, role: "dm", fog: false, view: isometric(1), camera: { x: 0, y: 0, scale: 40 }, lowPower: false }, new DrawnHeightsMemo());
  const cam = framed(row("drawing", "d1", { x: 10, y: 10, width: 2, height: 2 }), {}, pick);
  const middle = viewToScreen(cam, toView(isometric(1), { x: 11, y: 11 }, 0));
  assert.ok(Math.abs(middle.x - 400) < 1e-6 && Math.abs(middle.y - 296) < 1e-6, JSON.stringify(middle));
});

test("an outline row on a 20 ft platform, tapped from far out where the platform lies flat, centers on its top as the board draws it at the zoom found (ISO34-ASTRA-13)", () => {
  const state = world({ heights: raised(8, 8, 14, 14, 20) });
  for (const lowPower of [false, true]) {
    for (const turn of [0, 1, 2, 3] as const) {
      const board = (camera: Camera) => boardPickFor({ room: state, scene: state.scenes.s1!, role: "dm", fog: false, view: isometric(turn), camera, lowPower, canvasHeight: 600 }, new DrawnHeightsMemo());
      const rect = { x: 10, y: 10, width: 2, height: 2 };
      const cam = framed(row("drawing", "d1", rect), {}, board({ x: 0, y: 0, scale: lowPower ? 20 : 10 }));
      const shown = board(cam);
      assert.equal(groundIn(shown, rect), 4, "the platform stands at the zoom found");
      const middle = viewToScreen(cam, toView(isometric(turn), { x: 11, y: 11 }, 4));
      assert.ok(Math.abs(middle.x - 400) < 1e-6 && Math.abs(middle.y - 296) < 1e-6, `Low power ${lowPower}, turn ${turn}: ${JSON.stringify(middle)}`);
    }
  }
});

