import { useCallback, useRef, type CSSProperties, type ReactNode, type Ref, type RefObject } from "react";
import { chromeZoom, smallUi } from "../features/device/layout.ts";
import { useUiScale } from "../features/device/settings.ts";
import { subpageBack, subpageKey, useSubpageFocus, type PanelHeader } from "../features/panels.ts";
import { useSheetDialog } from "../lib/modalDialog.ts";
import { DraftScope, useDraftRegistry, useSheetSwipe } from "../lib/sheetSwipe.ts";
import { theme } from "../lib/theme.ts";
import { headerStacks, sheetMaxHeight } from "./sheetCap.ts";
import { SheetHeader, type HeaderBack } from "./SheetHeader.tsx";

/** Where a sheet stands (docs/design-v1-layout-hierarchy.md 4.2): at a phone's foot, on the right of one held sideways, or over the whole screen where that is too short. */
export type SheetMode = "bottom" | "side" | "full";

/**
 * A panel over the map on phones (design section 14.4): a bottom sheet in
 * portrait, a sheet docked on the right in landscape, where the short
 * screen height has no room for one at the bottom. `inset` keeps it clear
 * of the top bar and the bottom toolbar, which both also grow by the safe
 * area, so the sheet adds that too. `onBack` puts a back button before the
 * title, for a sheet opened from another sheet.
 *
 * A sheet takes this device's interface size (features/device/layout.ts),
 * as the bars it stands between do, so its insets in its own pixels meet
 * theirs.
 *
 * `subpage` is the panel's subpage, from usePanelHeader through
 * PanelHeaderHost (features/panels.ts): while set, the header shows the
 * subpage's title, and its back button returns to the panel's first page
 * ("Back to Menu") instead of doing `onBack`. The sheet keeps its own name,
 * the panel's, for its region and its close button. Focus follows: to the
 * title on entry, back to the opener on Back (useSubpageFocus).
 *
 * `reserveTop` keeps that many pixels free above a bottom sheet for what
 * docks on its edge (docs/design-v1-visual.md 3.2.1), in place of the
 * usual 24 px gap, and the sheet never goes below 120 px (sheetCap.ts).
 * A sheet on the right runs the screen's height, so it has no reserve.
 *
 * The sheet is one `<dialog>` from the moment its panel opens until it
 * closes (lib/modalDialog.ts useSheetDialog), whatever its mode, so a
 * change of mode or Hide never remounts the panel. Its inner `<section>`
 * keeps the panel's name and the region role every query and landmark
 * finds a sheet by. On the right it gains Hide (`onHide`), which closes
 * the dialog and keeps the panel, and where the screen is too short for
 * a body of 88 px beside the map, the very short mode (`full`) opens it
 * modal over the whole screen, inside the safe areas on every side, with
 * the room's notices inside it, which the modal would otherwise leave out
 * of reach: `notices`, between the header and the body, which they push
 * down (pages/modalSlot.tsx).
 *
 * At the foot it swipes down to close (lib/sheetSwipe.ts,
 * docs/design-v1-sheet-swipe.md): from its header at any time, from its
 * body once that is at its top. `riders` ride its top edge and move with
 * it, the dock's row (pages/RoomDock.tsx). It provides its panel the
 * context that reports unsaved input, which makes a swipe spring back.
 */
export function Sheet(props: {
  ref?: Ref<HTMLElement>;
  title: string;
  mode: SheetMode;
  inset: { top: number; bottom: number };
  onClose(): void;
  onBack?(): void;
  backLabel?: string;
  subpage?: PanelHeader | null;
  reserveTop?: number;
  /** In the header, between the title and the close button, such as the dock's buttons when the dock has no room (3.2.1). */
  actions?: ReactNode;
  /** How many buttons `actions` holds, for whether the header stacks. */
  actionCount?: number;
  /** Focus moves to the back button, or the close button without one, once the token bar's Close leaves the sheet (3.2.1). */
  backRef?: Ref<HTMLButtonElement>;
  closeRef?: Ref<HTMLButtonElement>;
  /** The header's title, a heading that takes focus from script, for a room that moves focus into the sheet it just opened. */
  titleRef?: RefObject<HTMLHeadingElement | null>;
  /** Hide, on the right or over the whole screen: the panel stays mounted and Panels shows it again. */
  onHide?(): void;
  /** False while hidden: the dialog closed, its content kept. */
  shown?: boolean;
  /** Where focus goes when the sheet hides with focus inside it: the toolbar's Panels. */
  hideFocus?: RefObject<HTMLElement | null>;
  /** The header's width in layout px, the sheet less its side padding and borders, which decides whether it stacks (sheetCap.ts headerStacks). */
  headerWidth: number;
  /** Under the header, above the body, in the very short mode. */
  notices?: ReactNode;
  /** What rides the sheet's top edge at the foot: the dock's row. */
  riders?: readonly (HTMLElement | null)[];
  children: ReactNode;
}) {
  const { mode, inset, subpage } = props;
  const zoom = useUiScale();
  const ownTitleRef = useRef<HTMLHeadingElement>(null);
  const titleRef = props.titleRef ?? ownTitleRef;
  const bodyRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  useSubpageFocus(subpage ?? null, { title: titleRef, body: bodyRef, root: sectionRef });
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const { ref: outer } = props;
  const setDialog = useCallback(
    (el: HTMLDialogElement | null) => {
      dialogRef.current = el;
      if (typeof outer === "function") return outer(el);
      if (outer) outer.current = el;
      return undefined;
    },
    [outer],
  );
  const onHide = mode === "bottom" ? undefined : props.onHide;
  const shown = props.shown ?? true;
  useSheetDialog(dialogRef, { shown, modal: mode === "full", onCancel: props.onClose, hideFocus: props.hideFocus });
  const drafts = useDraftRegistry();
  // What it shows: the panel by its name, and its subpage by the key focus follows, so a new page or subpage ends a drag and drops a slide's close.
  const item = `${props.title}\n${subpage ? subpageKey(subpage) : ""}`;
  useSheetSwipe(dialogRef, { enabled: mode === "bottom" && shown, onClose: props.onClose, scroller: bodyRef, riders: props.riders, item, clip: "foot", drafts });
  const back: HeaderBack | null = subpage ? subpageBack(subpage) : props.onBack ? { label: props.backLabel ?? "Back", onBack: props.onBack } : null;
  const actionCount = props.actions ? (props.actionCount ?? 0) : 0;
  const stacked = headerStacks({ width: props.headerWidth, buttons: (back ? 1 : 0) + (onHide ? 1 : 0) + 1 + actionCount, actions: actionCount > 0 });
  const insetTop = `calc(${theme.safe.top} + ${inset.top}px)`;
  const insetBottom = `calc(${theme.safe.bottom} + ${inset.bottom}px)`;
  const box: CSSProperties =
    mode === "bottom"
      ? {
          position: "absolute",
          top: "auto",
          left: 0,
          right: 0,
          bottom: insetBottom,
          width: "auto",
          height: "auto",
          maxWidth: "none",
          maxHeight: sheetMaxHeight(inset, props.reserveTop),
          borderRadius: `${theme.radius.lg}px ${theme.radius.lg}px 0 0`,
          padding: `0 ${theme.safe.right} 0 ${theme.safe.left}`,
          zIndex: theme.z.sheet,
          boxShadow: theme.shadow.sheet,
        }
      : mode === "side"
        ? {
            position: "absolute",
            top: insetTop,
            bottom: insetBottom,
            left: "auto",
            right: 0,
            width: theme.layout.landscapeSheetWidth,
            height: "auto",
            maxWidth: "60%",
            maxHeight: "none",
            borderRadius: `${theme.radius.lg}px 0 0 ${theme.radius.lg}px`,
            padding: `0 ${theme.safe.right} 0 0`,
            zIndex: theme.z.sheet,
            boxShadow: theme.shadow.sheet,
          }
        : {
            // Modal, in the browser's top layer: the whole screen, its content inside the safe areas on all four sides. No border: at the screen's edges it frames nothing, and the body is short enough here to want its 2 px.
            position: "fixed",
            border: "none",
            inset: 0,
            width: "100%",
            height: "100%",
            maxWidth: "none",
            maxHeight: "none",
            borderRadius: 0,
            padding: `${theme.safe.top} ${theme.safe.right} ${theme.safe.bottom} ${theme.safe.left}`,
          };
  return (
    <dialog
      ref={setDialog}
      aria-label={props.title}
      data-rvtt-sheet=""
      {...smallUi(zoom)}
      style={{
        ...chromeZoom(zoom),
        boxSizing: "border-box",
        margin: 0,
        // Open, it lays out as a column. Closed, globals.css hides it, since this inline display would beat the browser's own rule for a closed dialog.
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        outline: "none",
        background: theme.color.surface,
        color: theme.color.text,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        ...box,
      }}
    >
      <section ref={sectionRef} aria-label={props.title} style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <SheetHeader
          title={subpage?.title ?? props.title}
          back={back}
          actions={props.actions}
          onClose={props.onClose}
          closeLabel={`Close ${props.title}`}
          onHide={onHide}
          hideLabel={`Hide ${props.title}`}
          stacked={stacked}
          backRef={props.backRef}
          closeRef={props.closeRef}
          titleRef={titleRef}
          grab={mode === "bottom"}
        />
        {mode === "full" ? props.notices : null}
        {/* Every mode keeps this shape, so a change of mode never mounts the panel again. */}
        <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {/* The 4 px on top hold the focus ring of a first full-width control (2 px out, 2 px wide), which the scrolling body would clip. */}
          {/* data-pane-body and the padding variables let a sticky header inside meet the scroller's edges in every mode (docs/design-v1-combat-flow.md 3.1). */}
          <div
            ref={bodyRef}
            data-pane-body=""
            style={{ ...paneBodyPadding(theme.space(1), theme.space(4)), flex: 1, minHeight: 0, overflowY: "auto", padding: `${theme.space(1)}px ${theme.space(4)}px ${theme.space(4)}px`, overscrollBehavior: "contain" }}
          >
            <DraftScope value={drafts}>{props.children}</DraftScope>
          </div>
        </div>
      </section>
    </dialog>
  );
}

/**
 * A scrolling pane body's top and side padding as CSS variables, for a
 * sticky header inside it. A sticky box keeps inside its scroller's
 * padding, so the header takes the padding back with a negative margin and
 * gives it back as its own padding (docs/design-v1-combat-flow.md 3.1).
 * Mark the body `data-pane-body` too, which the header looks for to
 * measure the room it has.
 */
export function paneBodyPadding(top: number, x: number): CSSProperties {
  return { ["--pane-pad-top" as string]: `${top}px`, ["--pane-pad-x" as string]: `${x}px` };
}
