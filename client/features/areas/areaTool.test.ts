import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHUNK_CELLS, type RoomState } from "#shared/model.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { room, scene, template, token } from "#shared/testutil.ts";
import { boardPickFor, boardPickSlot, drawnAt, DrawnHeightsMemo, pressAt } from "../../canvas/boardPick.ts";
import { screenToView, viewToScreen, type Camera } from "../../lib/camera.ts";
import { isometric, toView, toWorld, type Turn } from "../../lib/view.ts";
import { RoomScope } from "../../state/scope.ts";
import type { ToolContext, ToolPointer } from "../tools.ts";
import { areaContext } from "./coverage.ts";
import { draftTemplate, handlePoint, newDraft, yawToward } from "./placement.ts";
import { areaSlot, HANDLE_GAP_PX } from "./store.ts";

const { areaTool } = await import("./AreaTool.tsx");

const CAM: Camera = { x: 400, y: 300, scale: 40 };
/** The platform's top in cells: 20 ft at 5 ft a cell. */
const TOP = 4;
const ORIGIN = { x: 6, y: 5.5, z: 20 };

/** A 16 by 16 scene with a 20 ft platform over cells 3 to 8 each way, and a 30 ft cone from its top whose far end and handle lie past its edge. */
function ledge(): RoomState {
  const state = room();
  state.scenes.s1 = scene("s1", { bounds: { w: 16, h: 16 } });
  const feet = new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0);
  for (let y = 3; y < 9; y++) for (let x = 3; x < 9; x++) feet[y * CHUNK_CELLS + x] = 20;
  state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {}, heights: encodeHeights(feet) };
  state.templates.a1 = template("a1", { shape: "cone", size: 30, origin: ORIGIN, yaw: 0 });
  return state;
}

function setUp(turn: Turn) {
  const state = ledge();
  const scope = new RoomScope();
  const pick = boardPickFor({ room: state, scene: state.scenes.s1!, role: "dm", fog: false, view: isometric(turn), camera: CAM, lowPower: false }, new DrawnHeightsMemo());
  scope.get(boardPickSlot).read = () => pick;
  const area = scope.get(areaSlot);
  area.store.setState({ snap: "free" });
  const sent: unknown[] = [];
  const ctx = {
    actions: { dispatch: (op: unknown) => (sent.push(op), 1), newId: () => "new", sendEph: () => {} },
    ui: { select: () => {} },
    getState: () => ({ view: state, you: { memberId: "dm1" }, local: { tool: "area", selectedId: null } }),
    scene: state.scenes.s1!,
    role: "dm",
    camera: () => CAM,
    scope,
  } as unknown as ToolContext;
  const at = (screen: { x: number; y: number }): ToolPointer => ({ world: pressAt(pick, screen), screen, pointerId: 1, pointerType: "mouse", button: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, tokenId: null });
  /** A point on the plane at the platform's top, as the preview draws there. */
  const drawn = (w: { x: number; y: number }) => viewToScreen(CAM, toView(pick.view, w, TOP));
  /** Where the finger at a screen point is on that plane. */
  const onTop = (screen: { x: number; y: number }) => toWorld(pick.view, screenToView(CAM, screen), TOP);
  return { state, area, ctx, sent, at, drawn, onTop, pick };
}

const TURNS: Turn[] = [0, 1, 2, 3];

for (const turn of TURNS) {
  test(`a placed cone on a 20 ft platform turns from its handle drawn past the edge, toward the finger on the cone's plane (ISO34-ASTRA-5, OPUS-4), turn ${turn}`, () => {
    const { state, area, ctx, sent, at, drawn, onTop } = setUp(turn);
    area.store.setState({ selectedId: "a1" });
    const handle = drawn(handlePoint(state.templates.a1!, areaContext(state, state.scenes.s1!), HANDLE_GAP_PX / CAM.scale));
    // A tap on the handle as drawn is a turn, so lifting keeps the area picked.
    areaTool.pointer!.down!(at(handle), ctx);
    areaTool.pointer!.up!(at(handle), ctx);
    assert.equal(area.store.getState().selectedId, "a1", "the press reached the handle where it draws");
    areaTool.pointer!.down!(at(handle), ctx);
    const to = { x: handle.x + 30, y: handle.y + 70 };
    areaTool.pointer!.move!(at(to), ctx);
    const live = area.store.getState().live;
    const want = yawToward(ORIGIN, onTop(to))!;
    assert.ok(live && live.yaw !== undefined && Math.abs(live.yaw - Math.round(want * 10) / 10) < 1e-9, JSON.stringify([live, want]));
    assert.deepEqual(live.origin ?? ORIGIN, ORIGIN, "turning leaves the origin where it was");
    areaTool.pointer!.up!(at(to), ctx);
    assert.equal((sent[0] as { t: string }).t, "template.update");
  });

  test(`a cone's draft with its point on a 20 ft platform aims at the finger on the plane where it draws, turn ${turn}`, () => {
    const { area, ctx, at, drawn, onTop } = setUp(turn);
    area.store.setState({ draft: { ...newDraft("d1", "cone", "#ff8800"), size: 30, point: { ...ORIGIN } } });
    // Over open ground off the platform, where the press's ray meets ground 4 cells lower.
    const press = drawn({ x: 11, y: 9 });
    areaTool.pointer!.down!(at(press), ctx);
    const want = yawToward(ORIGIN, onTop(press))!;
    assert.ok(Math.abs(area.store.getState().draft!.yaw - Math.round(want * 10) / 10) < 1e-9, JSON.stringify([area.store.getState().draft!.yaw, want]));
    const to = { x: press.x - 50, y: press.y + 40 };
    areaTool.pointer!.move!(at(to), ctx);
    const turned = yawToward(ORIGIN, onTop(to))!;
    assert.ok(Math.abs(area.store.getState().draft!.yaw - Math.round(turned * 10) / 10) < 1e-9, JSON.stringify([area.store.getState().draft!.yaw, turned]));
  });

  test(`a cone cast from a Huge creature on the platform's edge aims on the plane at its origin, which draws on the ground below, turn ${turn}`, () => {
    const { state, area, ctx, at, pick } = setUp(turn);
    state.tokens.ogre = token("ogre", { size: "huge", x: 7, y: 4 });
    const d = { ...newDraft("d1", "cone", "#ff8800"), size: 30, casterId: "ogre", fromId: "ogre" };
    area.store.setState({ draft: d });
    const origin = draftTemplate(d, state.tokens, 5)!.origin;
    assert.equal(drawnAt(pick, origin), 0, "the cone starts on the east edge, off the platform");
    assert.equal(drawnAt(pick, { x: 8.5, y: 5.5 }), TOP, "while the creature's center, the aim's pivot, is on it");
    const press = viewToScreen(CAM, toView(pick.view, { x: 13, y: 7.5 }, 0));
    areaTool.pointer!.down!(at(press), ctx);
    const want = yawToward({ x: 8.5, y: 5.5 }, toWorld(pick.view, screenToView(CAM, press), 0))!;
    assert.ok(Math.abs(area.store.getState().draft!.yaw - Math.round(want * 10) / 10) < 1e-9, JSON.stringify([area.store.getState().draft!.yaw, want]));
  });
}
