import { createStore } from "zustand/vanilla";
import type { DrawingKind, RoomState } from "#shared/model.ts";
import { scopeSlot, type RoomScope } from "../../state/scope.ts";
import type { RoomView } from "../../state/types.ts";
import type { ToolContext } from "../tools.ts";
import { drawAccess, type DrawAccess } from "./gate.ts";

/**
 * The Draw tool's choices, its draft and its gesture, apart from the tool's
 * .tsx so the row and the tool's key share one list and one pick, and the
 * unit tests can load them (docs/design-v1-tool-cycle.md 2.13).
 */

/** A kept ruler is a drawing too, but the ruler tool makes and removes it (features/measure). */
export type DrawMode = Exclude<DrawingKind, "ruler"> | "erase";

export type DrawToolState = {
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
};

/** `told` is set once the eraser has said it cannot erase someone else's drawing, so a stroke says it once. */
export type DrawGesture = { screen: { x: number; y: number }; lastScreen: { x: number; y: number }; moved: boolean; erased: Set<string>; told?: boolean };

/** One Room page's drawing tool: its choices and draft, the gesture in progress, and the context its option buttons act through. */
export const drawSlot = scopeSlot(() => ({
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
  })),
  gesture: null as DrawGesture | null,
  /** Room.tsx renders Options without a tool context, so the buttons reach the tool through this. */
  activeCtx: null as ToolContext | null,
  /** What the tool offered when it opened, so losing the right to draw closes it with a word of why (gate.ts). */
  openedAs: null as DrawAccess | null,
}));

const EMPTY_DRAWINGS: RoomState["drawings"] = {};

/** What the Draw tool offers this viewer now (gate.ts). */
export function accessOf(s: RoomView): DrawAccess {
  if (!s.you) return "none";
  return drawAccess({ role: s.you.role, memberId: s.you.memberId, settings: s.view?.meta.settings ?? {}, drawings: s.view?.drawings ?? EMPTY_DRAWINGS, sceneId: s.sceneId });
}

/** The drawing tools in the row's order, which the tool's key steps through too. */
export const DRAW_MODES: readonly { value: DrawMode; label: string }[] = [
  { value: "free", label: "Pen" },
  { value: "line", label: "Line" },
  { value: "arrow", label: "Arrow" },
  { value: "rect", label: "Box" },
  { value: "ellipse", label: "Circle" },
  { value: "polygon", label: "Shape" },
  { value: "text", label: "Text" },
  { value: "erase", label: "Eraser" },
];

/** A new drawing tool, which ends any shape or text in progress. */
export function pickDrawMode(scope: RoomScope, mode: DrawMode): void {
  scope.get(drawSlot).store.setState({ mode, draft: null, textAt: null });
}
