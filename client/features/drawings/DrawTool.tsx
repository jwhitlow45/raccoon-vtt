import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { DrawingKind, RoomState } from "#shared/model.ts";
import type { DrawingInput } from "#shared/protocol.ts";
import { TAP_SLOP_PX } from "../../lib/gestures.ts";
import { Segmented } from "../../components/Segmented.tsx";
import { Swatches } from "../../components/Swatches.tsx";
import { MEMBER_COLORS, theme } from "../../lib/theme.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import type { RoomView } from "../../state/types.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import type { ToolContext, ToolDef, ToolPointer } from "../tools.ts";
import { InfoLine, OptButton, OptInput, OptionsColumn, OptionsRow, OptSelect } from "../measure/controls.tsx";
import { DRAWING_TURNED_OFF, drawAccess, type DrawAccess } from "./gate.ts";
import { eraseTarget, estimateEm, fillable, fillFor, simplifyStroke } from "./geometry.ts";
import { TOOL_ORDER } from "../toolbarOrder.ts";

/**
 * The drawing tool (features section 12, design 6 and 7.7): freehand, line,
 * rectangle, ellipse, polygon, arrow and text, in a color, width, opacity
 * and optional fill, plus the eraser for your own drawings (the DM's
 * erases any), undo, and clearing.
 *
 * A freehand stroke is simplified with Douglas-Peucker before it is sent,
 * at a tolerance of about one screen pixel, and capped at the protocol's
 * 2,000 numbers. Every drawing is one `drawing.create` on lift, so a
 * stroke costs one op however long it is. The stroke in progress shows
 * only here, from this tool's state.
 */

/** A kept ruler is a drawing too, but the ruler tool makes and removes it (features/measure). */
export type DrawMode = Exclude<DrawingKind, "ruler"> | "erase";

type DrawToolState = {
  mode: DrawMode;
  /** Null means the member's own color. */
  color: string | null;
  width: number;
  opacity: number;
  fill: boolean;
  dmOnly: boolean;
  /** The drawing in progress, in cells. A polygon's holds its vertices so far. */
  draft: { kind: DrawingKind; points: number[] } | null;
  /** Where a text goes, waiting for its words. */
  textAt: { x: number; y: number } | null;
  text: string;
  /** "Clear all" asks for a second tap. */
  clearArmed: boolean;
};

/** `told` is set once the eraser has said it cannot erase someone else's drawing, so a stroke says it once. */
type DrawGesture = { screen: { x: number; y: number }; lastScreen: { x: number; y: number }; moved: boolean; erased: Set<string>; told?: boolean };

/** One Room page's drawing tool: its choices and draft, the gesture in progress, and the context its option buttons act through. */
const drawSlot = scopeSlot(() => ({
  store: createStore<DrawToolState>(() => ({
    mode: "free",
    color: null,
    width: 4,
    opacity: 1,
    fill: false,
    dmOnly: false,
    draft: null,
    textAt: null,
    text: "",
    clearArmed: false,
  })),
  gesture: null as DrawGesture | null,
  /** Room.tsx renders Options without a tool context, so the buttons reach the tool through this. */
  activeCtx: null as ToolContext | null,
  /** What the tool offered when it opened, so losing the right to draw closes it with a word of why (gate.ts). */
  openedAs: null as DrawAccess | null,
}));

const EMPTY_DRAWINGS: RoomState["drawings"] = {};

/** What the Draw tool offers this viewer now (gate.ts). */
function accessOf(s: RoomView): DrawAccess {
  if (!s.you) return "none";
  return drawAccess({ role: s.you.role, memberId: s.you.memberId, settings: s.view?.meta.settings ?? {}, drawings: s.view?.drawings ?? EMPTY_DRAWINGS, sceneId: s.sceneId });
}

/**
 * A player the DM just stopped from drawing: the tool closes and says why.
 * Their drawings stay, and the tool comes back in its eraser-only form
 * while they have drawings of their own on the scene.
 */
function closeForLostDrawing(ctx: Pick<ToolContext, "ui">): void {
  ctx.ui.setTool("select");
  ctx.ui.notify(DRAWING_TURNED_OFF);
}

export function useDrawTool<T>(selector: (s: DrawToolState) => T): T {
  return useStore(useScoped(drawSlot).store, selector);
}

/** How close, in screen pixels, a tap must land to a polygon's first vertex to close it. */
const CLOSE_PX = 18;
/** Freehand points closer than this on screen add nothing the simplifier would keep. */
const STEP_PX = 2;
/** The eraser's reach around the finger, in screen pixels. */
const ERASE_PX = 12;
/** A polygon's corners stop here: 2,000 numbers is the op's cap. */
const MAX_VERTICES = 1_000;
/** A raw freehand stroke stops growing here. Simplifying brings it under the op's cap. */
const MAX_RAW_VALUES = 20_000;

const round = (v: number) => Math.round(v * 100) / 100;

function strokeColor(ctx: ToolContext, color: string | null): string {
  if (color) return color;
  const s = ctx.getState();
  return (s.you && s.view?.members[s.you.memberId]?.color) || theme.color.crest;
}

function create(ctx: ToolContext, kind: DrawingKind, points: number[], text?: string): void {
  const s = ctx.getState();
  const st = ctx.scope.get(drawSlot).store.getState();
  if (!s.you) return;
  const stroke = strokeColor(ctx, st.color);
  const drawing: DrawingInput = {
    id: ctx.actions.newId(),
    sceneId: ctx.scene.id,
    kind,
    points: points.map(round),
    style: { stroke, width: st.width, opacity: st.opacity },
    ownerId: s.you.memberId,
    visibility: ctx.role === "dm" && st.dmOnly ? "dm" : "all",
  };
  if (st.fill && fillable(kind)) drawing.style.fill = fillFor(stroke);
  if (text !== undefined) drawing.text = text;
  ctx.actions.dispatch({ t: "drawing.create", drawing });
}

let measureContext: CanvasRenderingContext2D | null | undefined;

/**
 * A text line's width in cells, measured as Konva measures it when it draws
 * (DrawingLayer.tsx): the bold map font at the drawing's own size in cells.
 * Browsers measure tiny fonts wider than a scaled large one, so measuring
 * at another size and scaling misses the end of the text.
 */
function measureText(line: string, fontSize: number): number {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return estimateEm(line) * fontSize;
  measureContext.font = `bold ${fontSize}px ${theme.font.body}`;
  return measureContext.measureText(line).width;
}

function eraseAt(p: ToolPointer, ctx: ToolContext): void {
  const s = ctx.getState();
  const gesture = ctx.scope.get(drawSlot).gesture;
  if (!s.view || !s.you || !gesture) return;
  const mine = s.you.memberId;
  const list = Object.values(s.view.drawings).filter((d) => d && d.sceneId === ctx.scene.id && d.kind !== "ruler");
  const hit = eraseTarget(list, p.world, ERASE_PX / ctx.camera().scale, (d) => ctx.role === "dm" || d.ownerId === mine, gesture.erased, measureText);
  if (!hit) return;
  if ("refused" in hit) {
    if (!gesture.told) ctx.ui.notify(ERASE_OTHERS);
    gesture.told = true;
    return;
  }
  gesture.erased.add(hit.erase.id);
  ctx.actions.dispatch({ t: "drawing.delete", drawingId: hit.erase.id });
}

function onDown(p: ToolPointer, ctx: ToolContext): void {
  const tool = ctx.scope.get(drawSlot);
  const drawStore = tool.store;
  const access = accessOf(ctx.getState());
  if (access !== "draw" && tool.openedAs === "draw") {
    closeForLostDrawing(ctx);
    return;
  }
  if (access === "none") {
    ctx.ui.setTool("select");
    return;
  }
  if (access === "erase" && drawStore.getState().mode !== "erase") drawStore.setState({ mode: "erase", draft: null, textAt: null });
  const st = drawStore.getState();
  tool.gesture = { screen: p.screen, lastScreen: p.screen, moved: false, erased: new Set() };
  const { x, y } = p.world;
  switch (st.mode) {
    case "erase":
      eraseAt(p, ctx);
      return;
    case "free":
      drawStore.setState({ draft: { kind: "free", points: [x, y] } });
      return;
    case "line":
    case "arrow":
    case "rect":
    case "ellipse":
      drawStore.setState({ draft: { kind: st.mode, points: [x, y, x, y] } });
      return;
    case "polygon":
    case "text":
      return;
  }
}

function onMove(p: ToolPointer, ctx: ToolContext): void {
  const { gesture: g, store: drawStore } = ctx.scope.get(drawSlot);
  if (!g) return;
  const st = drawStore.getState();
  if (!g.moved && Math.hypot(p.screen.x - g.screen.x, p.screen.y - g.screen.y) >= TAP_SLOP_PX) g.moved = true;
  if (st.mode === "erase") {
    eraseAt(p, ctx);
    return;
  }
  const d = st.draft;
  if (!d) return;
  if (d.kind === "free") {
    if (Math.hypot(p.screen.x - g.lastScreen.x, p.screen.y - g.lastScreen.y) < STEP_PX || d.points.length >= MAX_RAW_VALUES) return;
    g.lastScreen = p.screen;
    drawStore.setState({ draft: { kind: "free", points: [...d.points, p.world.x, p.world.y] } });
  } else if (d.kind !== "polygon") {
    drawStore.setState({ draft: { kind: d.kind, points: [d.points[0]!, d.points[1]!, p.world.x, p.world.y] } });
  }
}

function onUp(p: ToolPointer, ctx: ToolContext): void {
  const tool = ctx.scope.get(drawSlot);
  const drawStore = tool.store;
  const g = tool.gesture;
  tool.gesture = null;
  if (!g) return;
  const st = drawStore.getState();
  const scale = ctx.camera().scale;
  const d = st.draft;
  switch (st.mode) {
    case "erase":
      return;
    case "free": {
      drawStore.setState({ draft: null });
      if (!d || d.points.length < 4) return;
      create(ctx, "free", simplifyStroke(d.points, 1 / scale));
      return;
    }
    case "line":
    case "arrow":
    case "rect":
    case "ellipse": {
      drawStore.setState({ draft: null });
      if (!d || !g.moved) return;
      create(ctx, st.mode, [d.points[0]!, d.points[1]!, p.world.x, p.world.y]);
      return;
    }
    case "polygon": {
      if (g.moved) return;
      const pts = d?.kind === "polygon" ? d.points : [];
      const n = pts.length / 2;
      if (n >= 3 && Math.hypot(p.world.x - pts[0]!, p.world.y - pts[1]!) * scale <= CLOSE_PX) {
        finishPolygon(ctx);
        return;
      }
      if (n >= MAX_VERTICES) return;
      drawStore.setState({ draft: { kind: "polygon", points: [...pts, p.world.x, p.world.y] } });
      return;
    }
    case "text":
      if (!g.moved) drawStore.setState({ textAt: { x: p.world.x, y: p.world.y }, text: "" });
      return;
  }
}

function finishPolygon(ctx: ToolContext): void {
  const drawStore = ctx.scope.get(drawSlot).store;
  const d = drawStore.getState().draft;
  drawStore.setState({ draft: null });
  if (d?.kind === "polygon" && d.points.length >= 6) create(ctx, "polygon", d.points);
}

function addText(ctx: ToolContext): void {
  const drawStore = ctx.scope.get(drawSlot).store;
  const { textAt, text } = drawStore.getState();
  const words = text.trim();
  drawStore.setState({ textAt: null, text: "" });
  if (textAt && words) create(ctx, "text", [textAt.x, textAt.y], words.slice(0, 1000));
}

const MODES: readonly { value: DrawMode; label: string }[] = [
  { value: "free", label: "Pen" },
  { value: "line", label: "Line" },
  { value: "arrow", label: "Arrow" },
  { value: "rect", label: "Box" },
  { value: "ellipse", label: "Circle" },
  { value: "polygon", label: "Shape" },
  { value: "text", label: "Text" },
  { value: "erase", label: "Eraser" },
];

const HINTS: Record<DrawMode, string> = {
  free: "Draw with one finger.",
  line: "Drag from one end to the other.",
  arrow: "Drag from the tail to the point.",
  rect: "Drag from corner to corner.",
  ellipse: "Drag across the circle's box.",
  polygon: "Tap each corner. Tap the first corner again, or Finish, to close it.",
  text: "Tap where the text goes.",
  erase: "Tap or drag over a drawing to erase it.",
};

const ERASE_OTHERS = "You can only erase your own drawings.";

function DrawOptions(props: { role: "dm" | "player" }) {
  const tool = useScoped(drawSlot);
  const drawStore = tool.store;
  const st = useStore(drawStore);
  const ui = useRoomUi();
  const access = useRoomView(accessOf);

  // The DM may change who can draw at any moment (docs/design-v1-dm-tools.md 3.9).
  useEffect(() => {
    if (access === "draw") {
      tool.openedAs = "draw";
      return;
    }
    if (tool.openedAs === "draw") {
      tool.openedAs = access;
      closeForLostDrawing({ ui });
      return;
    }
    if (access === "none") ui.setTool("select");
    else if (drawStore.getState().mode !== "erase") drawStore.setState({ mode: "erase", draft: null, textAt: null });
  }, [access, tool, ui, drawStore]);
  // Read when tapped: the canvas activates the tool after this first renders.
  const withTool = (fn: (ctx: ToolContext) => void) => tool.activeCtx && fn(tool.activeCtx);
  const memberColor = useRoomView((s) => (s.you ? s.view?.members[s.you.memberId]?.color : undefined)) ?? theme.color.crest;
  const actions = useRoomActions();
  const sceneId = useRoomView((s) => s.sceneId);
  const color = st.color ?? memberColor;

  useEffect(() => {
    if (!st.clearArmed) return;
    const t = setTimeout(() => drawStore.setState({ clearArmed: false }), 3000);
    return () => clearTimeout(t);
  }, [st.clearArmed]);

  if (access !== "draw") {
    return (
      <OptionsColumn>
        <InfoLine tone="muted">The DM has not let you draw. You can still erase your own drawings: tap or drag over one, or clear them all.</InfoLine>
        <OptionsRow label="Your drawings">
          <OptButton label="Undo your last change" onClick={() => actions.undo()}>
            Undo
          </OptButton>
          <OptButton tone="danger" disabled={!sceneId} onClick={() => sceneId && actions.dispatch({ t: "drawing.clear", sceneId, scope: "own" })}>
            Clear mine
          </OptButton>
        </OptionsRow>
      </OptionsColumn>
    );
  }

  const polygonVertices = st.draft?.kind === "polygon" ? st.draft.points.length / 2 : 0;
  return (
    <OptionsColumn>
      <InfoLine tone="muted">{st.mode === "erase" && props.role === "player" ? "Tap or drag over one of your own drawings to erase it." : HINTS[st.mode]}</InfoLine>
      {st.textAt ? (
        <OptionsRow label="Text">
          <OptInput label="Text" placeholder="Text on the map" value={st.text} autoFocus width={200} onChange={(text) => drawStore.setState({ text })} onEnter={() => withTool(addText)} />
          <OptButton tone="primary" disabled={!st.text.trim()} onClick={() => withTool(addText)}>
            Add
          </OptButton>
          <OptButton onClick={() => drawStore.setState({ textAt: null, text: "" })}>Cancel</OptButton>
        </OptionsRow>
      ) : null}
      {polygonVertices > 0 ? (
        <OptionsRow label="Shape">
          <OptButton tone="primary" disabled={polygonVertices < 3} onClick={() => withTool(finishPolygon)}>
            Finish
          </OptButton>
          <OptButton onClick={() => drawStore.setState({ draft: { kind: "polygon", points: st.draft!.points.slice(0, -2) } })}>Undo corner</OptButton>
          <OptButton onClick={() => drawStore.setState({ draft: null })}>Cancel</OptButton>
        </OptionsRow>
      ) : null}
      <OptionsRow label="Drawing">
        <OptSelect<DrawMode> label="Drawing tool" value={st.mode} options={MODES} onChange={(mode) => drawStore.setState({ mode, draft: null, textAt: null })} />
        <OptButton label="Undo your last change" onClick={() => actions.undo()}>
          Undo
        </OptButton>
        <OptButton label="Redo" onClick={() => actions.redo()}>
          Redo
        </OptButton>
        <Swatches label="Color" value={color} options={MEMBER_COLORS} onChange={(c) => drawStore.setState({ color: c })} />
        <Segmented
          label="Width"
          value={String(st.width)}
          options={[
            { value: "2", label: "Thin" },
            { value: "4", label: "Mid" },
            { value: "8", label: "Thick" },
          ]}
          onChange={(w) => drawStore.setState({ width: Number(w) })}
        />
        <Segmented
          label="Opacity"
          value={String(st.opacity)}
          options={[
            { value: "1", label: "Solid" },
            { value: "0.6", label: "60%" },
            { value: "0.3", label: "30%" },
          ]}
          onChange={(o) => drawStore.setState({ opacity: Number(o) })}
        />
        <OptButton pressed={st.fill} onClick={() => drawStore.setState({ fill: !st.fill })}>
          Fill
        </OptButton>
        {props.role === "dm" ? (
          <OptButton pressed={st.dmOnly} label="Only the DM sees new drawings" onClick={() => drawStore.setState({ dmOnly: !st.dmOnly })}>
            DM only
          </OptButton>
        ) : null}
        <OptButton tone="danger" disabled={!sceneId} onClick={() => sceneId && actions.dispatch({ t: "drawing.clear", sceneId, scope: "own" })}>
          Clear mine
        </OptButton>
        {props.role === "dm" ? (
          <OptButton
            tone="danger"
            pressed={st.clearArmed}
            disabled={!sceneId}
            onClick={() => {
              if (!sceneId) return;
              if (!st.clearArmed) {
                drawStore.setState({ clearArmed: true });
                return;
              }
              drawStore.setState({ clearArmed: false });
              actions.dispatch({ t: "drawing.clear", sceneId, scope: "all" });
            }}
          >
            {st.clearArmed ? "Tap again to clear all" : "Clear all"}
          </OptButton>
        ) : null}
      </OptionsRow>
    </OptionsColumn>
  );
}

export const drawTool: ToolDef = {
  id: "draw",
  label: "Draw",
  icon: { path: "M4 20l1.2-4.6L16.6 4l3.4 3.4L8.6 18.8zM17.8 2.8l1.4-1.4 3.4 3.4-1.4 1.4z" },
  roles: ["dm", "player"],
  order: TOOL_ORDER.draw,
  cursor: "crosshair",
  pointer: {
    down: onDown,
    move: onMove,
    up: onUp,
    cancel(ctx) {
      const tool = ctx.scope.get(drawSlot);
      tool.gesture = null;
      const d = tool.store.getState().draft;
      // A pinch abandons a stroke or a drag, but a polygon keeps the corners tapped so far.
      if (d && d.kind !== "polygon") tool.store.setState({ draft: null });
    },
  },
  activate(ctx) {
    const tool = ctx.scope.get(drawSlot);
    tool.activeCtx = ctx;
    tool.openedAs = accessOf(ctx.getState());
    if (tool.openedAs === "erase") tool.store.setState({ mode: "erase", draft: null, textAt: null });
  },
  deactivate(ctx) {
    const tool = ctx.scope.get(drawSlot);
    tool.gesture = null;
    tool.store.setState({ draft: null, textAt: null, text: "", clearArmed: false });
    if (tool.activeCtx === ctx) tool.activeCtx = null;
    // The next opening decides afresh, so an eraser opened later never reads as drawing taken away.
    tool.openedAs = null;
  },
  Options: DrawOptions,
  // A player the DM has not let draw has no Draw tool, unless drawings of their own are there to erase.
  hidden: (s) => accessOf(s) === "none",
};
