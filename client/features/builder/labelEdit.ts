import type { Label } from "#shared/model.ts";
import { MAX_NAME } from "#shared/protocol.ts";
import type { LabelBox } from "#shared/rules/labels.ts";
import { paneLane, SUMMARY_ROW, type PaneLane, type PaneLaneBox } from "../../canvas/barDock.ts";
import type { Insets, Size } from "../../lib/camera.ts";
import type { BuildMode } from "./store.ts";

/**
 * The rules of a map label's edit pane (features section 3): which taps
 * open it, what it offers, when Delete fires and where the pane sits. Plain
 * functions, so they run under node --test. LabelPane.tsx draws the pane,
 * and labelTap.ts and the canvas feed it taps.
 */

/** Label sizes in cells, for placing a label and in its pane. */
export const LABEL_SIZES = [
  { value: 0.45, label: "S" },
  { value: 0.7, label: "M" },
  { value: 1.1, label: "L" },
] as const;

export type SizeOption = { value: number; label: string };

function sameSize(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

/**
 * The sizes the pane offers for a label of size `current`. A label can hold
 * a size the list lacks (from a backup, or a list that changed since), and
 * that size stays a choice of its own, so Done never resizes a label the DM
 * did not resize.
 */
export function paneSizes(current: number): SizeOption[] {
  // A listed size off by a rounding error takes the label's own value, so it shows as chosen.
  const list: SizeOption[] = LABEL_SIZES.map((o) => ({ value: sameSize(o.value, current) ? current : o.value, label: o.label }));
  if (list.some((o) => o.value === current)) return list;
  return [...list, { value: current, label: String(Math.round(current * 100) / 100) }].sort((a, b) => a.value - b.value);
}

/** What the pane needs to know about the tool in use. */
export type PaneTool = {
  role: "dm" | "player";
  /** The active tool's id. */
  tool: string;
  /** The builder's mode, which matters only while the builder is the tool. */
  mode: BuildMode;
};

/**
 * Whether a label's pane may be open. Labels are the DM's to edit. The
 * builder's other modes put a tap to their own use (paint, erase, a wall),
 * and the other tools to theirs, so only Select and the builder's Label
 * mode open it.
 */
export function labelPaneAllowed(t: PaneTool): boolean {
  return t.role === "dm" && (t.tool === "select" || (t.tool === "build" && t.mode === "label"));
}

export type LabelTapOutcome = { kind: "open"; labelId: string } | { kind: "close" } | { kind: "pass" };

/**
 * What a tap on the map does to the pane. A tap on a label opens its pane,
 * and a tap away from one closes the pane that is open, without placing a
 * label or letting go of anything else. Otherwise the tap is the tool's
 * (`pass`): the builder places a label, Select lets go of the selection.
 */
export function labelTapOutcome(input: PaneTool & { hit: string | null; open: string | null }): LabelTapOutcome {
  if (!labelPaneAllowed(input)) return { kind: "pass" };
  if (input.hit !== null) return { kind: "open", labelId: input.hit };
  return input.open !== null ? { kind: "close" } : { kind: "pass" };
}

/**
 * A label's text as typed, made fit to send: a pasted tab or line break,
 * which the protocol refuses in single-line text, becomes a space, and the
 * ends are trimmed.
 */
export function cleanLabelText(text: string): string {
  return text.replace(/[\p{Cc}\u2028\u2029]/gu, " ").trim();
}

export type LabelDraft = { text: string; size: number };

export type LabelCommit =
  | { kind: "update"; label: { x: number; y: number; text: string; size: number } }
  /** Nothing changed, so Done sends nothing and leaves no empty step to undo. */
  | { kind: "unchanged" }
  /** No text left. Delete is how a label goes. */
  | { kind: "empty" }
  | { kind: "tooLong" };

/** What Done sends for a draft. The label stays where it is now, which a drag may have changed since the pane opened. */
export function commitDraft(label: Pick<Label, "x" | "y" | "text" | "size">, draft: LabelDraft): LabelCommit {
  const text = cleanLabelText(draft.text);
  if (!text) return { kind: "empty" };
  if (text.length > MAX_NAME) return { kind: "tooLong" };
  if (text === label.text && sameSize(draft.size, label.size)) return { kind: "unchanged" };
  return { kind: "update", label: { x: label.x, y: label.y, text, size: draft.size } };
}

/** How long Delete waits for its second tap, as the app's other confirm buttons do. */
export const CONFIRM_MS = 4_000;

/** Whether Delete, first tapped at `armedAt`, is waiting for its second tap. */
export function deleteArmed(armedAt: number | null, now: number): boolean {
  return armedAt !== null && now - armedAt >= 0 && now - armedAt < CONFIRM_MS;
}

/** A tap on Delete: the first arms it, a second while armed deletes. */
export function tapDelete(armedAt: number | null, now: number): { armedAt: number | null; confirmed: boolean } {
  return deleteArmed(armedAt, now) ? { armedAt: null, confirmed: true } : { armedAt: now, confirmed: false };
}

/**
 * Whether an Escape closes the pane. A modal dialog over the room takes it,
 * and so does a text field outside the pane, which uses Escape to drop its
 * own edit. Inside the pane Escape closes it, dropping the draft. The room
 * marks an Escape it used for something nearer (a phone's sheet) as
 * handled.
 */
export function paneEscape(input: { key: string; handled: boolean; dialogOpen: boolean; editingElsewhere: boolean }): boolean {
  return input.key === "Escape" && !input.handled && !input.dialogOpen && !input.editingElsewhere;
}

/**
 * Where to pan the map so a label shows above its bottom sheet, as
 * fractions of the canvas (encounter/pan.ts requestPan), or null when it
 * already shows between the top bar and the sheet. On a phone the sheet
 * and the builder's option bar together cover most of the lower half, where
 * the label tapped often is.
 */
export function sheetPanAnchor(input: { viewport: Size; insets: Insets; sheetHeight: number; box: LabelBox }): { x: number; y: number } | null {
  const { viewport, box } = input;
  const top = input.insets.top + MARGIN;
  const bottom = viewport.height - input.insets.bottom - input.sheetHeight - MARGIN;
  if (bottom <= top) return null;
  const shows = box.y0 >= top && box.y1 <= bottom && box.x0 >= 0 && box.x1 <= viewport.width;
  return shows ? null : { x: 0.5, y: (top + bottom) / 2 / viewport.height };
}

/** Below this canvas width the pane is a bottom sheet, as panels are on a phone. */
export const SHEET_BELOW_PX = 600;
export const PANE_WIDTH = 296;
/** The gap between a label and its pane. */
const GAP = 10;
const MARGIN = 8;
/** A pane squeezed past this scrolls rather than shrinking further. */
export const PANE_MIN_HEIGHT = 120;

/**
 * `overBars`: a bottom sheet that stands over the top bars, where they
 * leave it less than its least height (labelPaneFrame draws it over
 * them). `lane`: a card's place against the alerts column while it shows
 * a card (canvas/barDock.ts paneLane), which the pane publishes so the
 * column shows its summary row for "summary".
 */
export type PanePlacement =
  | { kind: "sheet"; bottom: number; maxHeight: number; overBars?: true }
  | { kind: "card"; left: number; top: number; width: number; maxHeight: number; lane?: PaneLane };

/** The height between the bars (`insets`) that a bottom sheet pane may take, less its margins. Where that is under PANE_MIN_HEIGHT, the pane keeps PANE_MIN_HEIGHT all the same, over the top bars. */
export function sheetPaneRoom(input: { viewport: Size; insets: Insets }): number {
  return input.viewport.height - input.insets.bottom - input.insets.top - 2 * MARGIN;
}

/**
 * Where the pane sits over the canvas. On a narrow screen it is a bottom
 * sheet just above the toolbar and the tool's options. Otherwise it hangs
 * under the label, or over it when there is more room there, clear of the
 * bars along each side (`insets`), and scrolls inside when it fits neither.
 * `box` is the label's box on screen, in pixels from the canvas's top left.
 *
 * A bottom sheet keeps its least height, 120 px, where the bars leave it
 * less, as at 480 x 320 at 130%, where they leave 78 px beside the Trap
 * tool's options. Shrunk to the room, its header alone would fill it, with
 * no room left to edit in. So there it stands over the top bars instead
 * (`overBars`), which would otherwise hide its header and Close, up to the
 * screen's top at most.
 *
 * A card keeps out of the fight's alerts while their column shows a card
 * (`lane`, canvas/barDock.ts paneLaneBox), whose cards would otherwise
 * cover its header, Close and folds (docs/design-v1-look-pass-2.md 2.8):
 * left of the lane where the room there holds it, else under the
 * column's summary row where it meets the lane across. A bottom sheet
 * leaves the lane to usePaneDock (pages/RoomDock.tsx), which folds the
 * column.
 */
export function panePlacement(input: { viewport: Size; insets: Insets; box: LabelBox; height: number; lane: PaneLaneBox | null }): PanePlacement {
  const { viewport, insets, box, height, lane } = input;
  const bottomLimit = viewport.height - insets.bottom - MARGIN;
  if (viewport.width < SHEET_BELOW_PX) {
    const room = sheetPaneRoom(input);
    if (room >= PANE_MIN_HEIGHT) return { kind: "sheet", bottom: insets.bottom, maxHeight: room };
    return { kind: "sheet", bottom: insets.bottom, maxHeight: Math.max(0, Math.min(PANE_MIN_HEIGHT, viewport.height - insets.bottom)), overBars: true };
  }
  const width = Math.min(PANE_WIDTH, viewport.width - insets.left - insets.right - 2 * MARGIN);
  const side = lane ? paneLane({ laneLeft: lane.left, roomLeft: insets.left, width }) : null;
  const rightLimit = Math.min(viewport.width - insets.right, side === "beside" && lane ? lane.left : Infinity) - MARGIN;
  const center = (box.x0 + box.x1) / 2;
  const left = Math.max(insets.left + MARGIN, Math.min(center - width / 2, rightLimit - width));
  // Under the summary row only where the card reaches across into the lane: elsewhere the row is not in its way.
  const underRow = side === "summary" && lane !== null && left + width > lane.left;
  const topLimit = underRow ? Math.max(insets.top, lane.top + SUMMARY_ROW) + MARGIN : insets.top + MARGIN;
  const belowTop = Math.max(topLimit, box.y1 + GAP);
  const spaceBelow = bottomLimit - belowTop;
  const aboveBottom = Math.min(bottomLimit, box.y0 - GAP);
  const spaceAbove = aboveBottom - topLimit;
  const placed = side === null ? null : { lane: side };
  if (height <= spaceBelow || spaceBelow >= spaceAbove) {
    return { kind: "card", left, top: belowTop, width, maxHeight: Math.max(PANE_MIN_HEIGHT, spaceBelow), ...placed };
  }
  return { kind: "card", left, top: Math.max(topLimit, aboveBottom - height), width, maxHeight: Math.max(PANE_MIN_HEIGHT, spaceAbove), ...placed };
}
