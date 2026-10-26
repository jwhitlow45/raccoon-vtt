import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { Label, RoomState } from "#shared/model.ts";
import { reveal } from "#shared/testutil.ts";
import { viewToScreen, type Camera } from "../../lib/camera.ts";
import { isometric, toView, type ViewPoint } from "../../lib/view.ts";
import { boardPickFor, boardPickSlot, DrawnHeightsMemo, screenAt } from "../../canvas/boardPick.ts";
import { RoomScope } from "../../state/scope.ts";
import { raised, world } from "../movement/testing.ts";
import { measureLabel } from "./draw.ts";
import { labelScreenBox } from "./labelPaneFrame.ts";
import { labelShape } from "./labelShape.ts";
import { labelLook, labelUnder } from "./labelTap.ts";

const CAM: Camera = { x: 500, y: 100, scale: 40 };
const CRYPT: Label = { id: "l1", sceneId: "s1", x: 5.5, y: 4.5, text: "Crypt", size: 1, rev: 0 } as Label;

before(() => {
  // Labels measure in a canvas, which node has none of: the estimate stands in.
  (globalThis as { document?: unknown }).document ??= { createElement: () => ({ getContext: () => null }) };
});

function roomWithLabel(): RoomState {
  const state = world({ heights: raised(4, 3, 8, 7, 10) });
  state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
  state.labels = { l1: CRYPT };
  return state;
}

function ctxFor(state: RoomState, role: "dm" | "player") {
  const scope = new RoomScope();
  const pick = boardPickFor({ room: state, scene: state.scenes.s1!, role, fog: true, view: isometric(0), camera: CAM, lowPower: false }, new DrawnHeightsMemo());
  scope.get(boardPickSlot).read = () => pick;
  return { ctx: { getState: () => ({ view: state }) as never, scene: state.scenes.s1!, camera: () => CAM, scope }, pick };
}

describe("a map label tapped in Isometric (docs/design-v1-isometric-view.md 6.2)", () => {
  test("a label standing on a 10 ft platform is reached by its text on screen, not where it would lie at 0", () => {
    const state = roomWithLabel();
    const { ctx, pick } = ctxFor(state, "dm");
    const look = labelLook(pick, "s1", CRYPT);
    assert.deepEqual({ upright: look.upright, ground: look.ground }, { upright: true, ground: 2 });
    const { box } = labelShape(CRYPT, isometric(0), { measure: measureLabel, upright: true, ground: 2 });
    const middle = viewToScreen(CAM, { x: box.x + box.width / 2, y: box.y + box.height / 2 } as ViewPoint);
    assert.equal(labelUnder(ctx, { x: 0, y: 0 }, middle)?.id, "l1");
    // The flat box's middle at 0 lies well below the standing text.
    const flatAt0 = viewToScreen(CAM, toView(isometric(0), { x: CRYPT.x, y: CRYPT.y }));
    assert.equal(labelUnder(ctx, { x: 0, y: 0 }, flatAt0), null);
  });

  test("the pane stands by the label as the board shows it", () => {
    const state = roomWithLabel();
    const { pick } = ctxFor(state, "dm");
    const box = labelScreenBox(CRYPT, CAM, labelLook(pick, "s1", CRYPT));
    const foot = screenAt(pick, CRYPT, 2);
    assert.ok(Math.abs((box.x0 + box.x1) / 2 - foot.x) < 1e-9);
    assert.ok(Math.abs(box.y1 - foot.y) < 1e-9, "the text's bottom on its anchor at the platform's top");
  });

  test("security: for a player a label over fog lies flat, and reads no hidden height", () => {
    const state = roomWithLabel();
    const fogged = labelLook(ctxFor(state, "player").pick, "s1", CRYPT);
    assert.deepEqual({ upright: fogged.upright, ground: fogged.ground }, { upright: false, ground: 0 });
    reveal(state, "s1", { x: 0, y: 0, w: 12, h: 12 });
    const seen = labelLook(ctxFor(state, "player").pick, "s1", CRYPT);
    assert.deepEqual({ upright: seen.upright, ground: seen.ground }, { upright: true, ground: 2 });
  });
});
