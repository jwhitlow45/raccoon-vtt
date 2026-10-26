import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref, type RefObject } from "react";
import { chromeZoom, smallUi } from "../features/device/layout.ts";
import { useUiScale } from "../features/device/settings.ts";
import { subpageBack, subpageKey, usePanelScroll, useSubpageFocus, type PanelHeader } from "../features/panels.ts";
import { bodyHoldsField, useFieldInView, useKeyboardView } from "../lib/keyboardInset.ts";
import { useSheetDialog } from "../lib/modalDialog.ts";
import { DraftScope, useDraftRegistry, useSheetSwipe } from "../lib/sheetSwipe.ts";
import { theme } from "../lib/theme.ts";
import { headerStacks, SHEET_MAX_WIDTH, sheetFoot, sheetKeyboard, sheetMaxHeight, sheetTop } from "./sheetCap.ts";
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
 *
 * Swiped up from its header, or by the Expand sheet button that Tab
 * reaches in its header, it fills the screen (`expanded`, 4.7): the very
 * short mode's shape, modal, with the upright sheet's rounded top corners,
 * its header still the upright sheet's, with no Hide. A short swipe down
 * brings it back to its normal height. While a drag holds it above its
 * normal top it takes that shape beside the map, drawn over the bars and
 * clipped at the toolbar, so the drag lays out once.
 *
 * While the on-screen keyboard is open (lib/keyboardInset.ts) it rides on
 * the keyboard in every mode: at the foot its bottom edge stands at the
 * visible area's bottom with its height capped to fit there (sheetCap.ts),
 * and on the right or over the whole screen it takes the visible area's
 * height. The field with focus scrolls into view in its body, with its
 * form, such as an amount's Spend and Cancel (useFieldInView). Where its
 * body is then too short to hold the field and its buttons, as on a phone
 * held sideways at 130%, it takes the visible area's whole height over the
 * bars while the keyboard stays up (`onTall`), still not modal, so focus
 * stays in the field, and comes back to its shape as the keyboard closes.
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
  /** The panel it shows, whose scroll it keeps as the panel leaves and puts back as it shows again (features/panels.ts usePanelScroll). The list of panels has none. */
  scrollKey?: string;
  /** What that panel is about, such as the token the Token panel shows: a place about another subject is not put back. */
  scrollSubject?: string | null;
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
  /** At the foot, the sheet fills the screen. Room keeps it latent elsewhere. */
  expanded?: boolean;
  /** Fills the screen or brings the sheet back to its normal height, by a swipe or the Expand sheet button. Without it the sheet never fills the screen. */
  onExpand?(on: boolean): void;
  /** The sheet's height cap at the foot for the layout now, in layout px (sheetCap.ts), which a long swipe from full screen measures by after a change of layout. */
  cap?: number;
  /** Whether it took the visible area's whole height to show the field typed in, which leaves the dock no edge to ride. */
  onTall?(tall: boolean): void;
  children: ReactNode;
}) {
  const { mode, inset, subpage } = props;
  const zoom = useUiScale();
  const view = useKeyboardView();
  const keyboard = sheetKeyboard(view, zoom);
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
  const drafts = useDraftRegistry();
  // What it shows: the panel by its name, and its subpage by the key focus follows, so a new page or subpage ends a drag and drops a slide's close.
  const item = `${props.title}\n${subpage ? subpageKey(subpage) : ""}`;
  const filled = mode === "bottom" && props.expanded === true;
  const { onExpand } = props;
  const full = onExpand ? { on: filled, set: onExpand, cap: props.cap ?? 0 } : undefined;
  const swipe = useSheetSwipe(dialogRef, { enabled: mode === "bottom" && shown, onClose: props.onClose, scroller: bodyRef, riders: props.riders, item, clip: "foot", drafts, full });
  // A drag above the normal top, and a step down from full screen, keep the whole screen's box beside the map until they come to rest.
  // Filled with focus outside it, as after a turn strip's tap, it lands on its title rather than its first control (sheetFocusAfter).
  useSheetDialog(dialogRef, { shown, modal: mode === "full" || (filled && !swipe.rising), onCancel: props.onClose, hideFocus: props.hideFocus, modalFocus: filled ? titleRef : undefined });
  // After the dialog opens, since a closed dialog's body has no box to scroll.
  usePanelScroll(props.scrollKey ?? null, subpage ?? null, bodyRef, props.scrollSubject ?? null);
  // Decided once the body has laid out over the keyboard, and kept until the keyboard closes, so the shape never flips under a finger.
  const [tall, setTall] = useState(false);
  const canTall = view !== null && mode !== "full" && !filled;
  useLayoutEffect(() => {
    if (!canTall) setTall(false);
    else if (!tall && bodyRef.current && bodyHoldsField(bodyRef.current, theme.space(2)) === false) setTall(true);
  }, [canTall, view, tall]);
  const { onTall } = props;
  useEffect(() => onTall?.(tall), [onTall, tall]);
  useEffect(() => () => onTall?.(false), [onTall]);
  useFieldInView(bodyRef, useMemo(() => ({ view, tall }), [view, tall]), theme.space(2));
  const back: HeaderBack | null = subpage ? subpageBack(subpage) : props.onBack ? { label: props.backLabel ?? "Back", onBack: props.onBack } : null;
  const actionCount = props.actions ? (props.actionCount ?? 0) : 0;
  const stacked = headerStacks({ width: props.headerWidth, buttons: (back ? 1 : 0) + (onHide ? 1 : 0) + 1 + actionCount, actions: actionCount > 0 });
  const insetTop = sheetTop(inset.top, keyboard);
  const insetBottom = sheetFoot(inset.bottom, keyboard);
  const wholeScreen: CSSProperties = {
    // Modal, in the browser's top layer: the whole screen, its content inside the safe areas on all four sides. No border: at the screen's edges it frames nothing, and the body is short enough here to want its 2 px.
    position: "fixed",
    border: "none",
    // With the keyboard open, the visible area: below where the page is panned out of view, above the keyboard.
    inset: keyboard ? `${keyboard.top}px 0 ${keyboard.inset}px` : 0,
    width: "100%",
    height: keyboard ? "auto" : "100%",
    maxWidth: "none",
    maxHeight: "none",
    borderRadius: 0,
    padding: `${theme.safe.top} ${theme.safe.right} ${theme.safe.bottom} ${theme.safe.left}`,
  };
  /*
   * At the foot it is no wider than a medium dialog and stands centered
   * over the map (sheetCap.ts SHEET_MAX_WIDTH), filled or rising too, so a
   * swipe up never widens it. Its side padding keeps the safe areas where
   * it spans a phone's whole width.
   */
  const bottomWidth: CSSProperties = { maxWidth: SHEET_MAX_WIDTH, margin: "0 auto" };
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
          ...bottomWidth,
          maxHeight: sheetMaxHeight(inset, props.reserveTop, keyboard),
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
        : wholeScreen;
  // Filled, it keeps the upright sheet's top corners, with the room behind showing in them, so they never square off as it reaches the top or round again on the step down.
  const sheetCorners = `${theme.radius.lg}px ${theme.radius.lg}px 0 0`;
  // Its shadow stays once it settles: on a tablet the capped column stands over the map, where a phone's spans the screen and shows none.
  const fullHeight: CSSProperties = { ...wholeScreen, ...bottomWidth, borderRadius: sheetCorners, boxShadow: theme.shadow.sheet };
  // Beside the map while a drag holds it above its normal top, so it is drawn over the bars as it rises.
  const rising: CSSProperties = { ...fullHeight, zIndex: theme.z.overBars };
  // Typing with no room for the field: the visible area's height over the bars, at the foot as a rising sheet stands, on the right at its own width.
  const tallShape: CSSProperties = mode === "side" && keyboard ? { ...box, top: `${keyboard.top}px`, bottom: `${keyboard.inset}px`, zIndex: theme.z.overBars } : rising;
  const shape = swipe.rising ? rising : filled ? fullHeight : tall && canTall ? tallShape : box;
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
        ...shape,
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
          fullScreen={mode === "bottom" && onExpand ? { pressed: filled, onPress: () => swipe.expand(!filled) } : undefined}
        />
        {mode === "full" || filled ? props.notices : null}
        {/* Every mode keeps this shape, so a change of mode never mounts the panel again. */}
        <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {/* The 4 px on top hold the focus ring of a first full-width control (2 px out, 2 px wide), which the scrolling body would clip. */}
          {/* data-pane-body and the padding variables let a sticky header inside meet the scroller's edges in every mode (docs/design-v1-combat-flow.md 3.1). */}
          <div
            ref={bodyRef}
            data-pane-body=""
            style={{ ...paneBodyPadding(theme.space(1), theme.space(4), theme.space(4)), flex: 1, minHeight: 0, overflowY: "auto", padding: `${theme.space(1)}px ${theme.space(4)}px ${theme.space(4)}px`, overscrollBehavior: "contain" }}
          >
            <DraftScope value={drafts}>{props.children}</DraftScope>
          </div>
        </div>
      </section>
    </dialog>
  );
}

/**
 * A scrolling pane body's padding as CSS variables, for a sticky header or
 * footer inside it. A sticky box keeps inside its scroller's padding, so
 * the header takes the padding back with a negative margin and gives it
 * back as its own padding (docs/design-v1-combat-flow.md 3.1), and a footer
 * does the same at the foot (stickyPaneFoot). Mark the body
 * `data-pane-body` too, which the header looks for to measure the room it
 * has.
 */
export function paneBodyPadding(top: number, x: number, bottom: number): CSSProperties {
  return { ["--pane-pad-top" as string]: `${top}px`, ["--pane-pad-x" as string]: `${x}px`, ["--pane-pad-bottom" as string]: `${bottom}px` };
}

/**
 * A footer stuck to the foot of a pane's scrolling body, such as the Log's
 * composer. At `bottom: 0` it would rest on the body's bottom padding, a
 * strip above the pane's edge where what scrolls shows under it. So it
 * sticks that padding lower, takes the padding back with a negative margin
 * so nothing is left to scroll below it, and gives it back as its own
 * padding under `pad`, so its fill reaches the edge. Outside a pane the
 * padding reads as 0 and it sticks at the foot as before.
 */
export function stickyPaneFoot(pad: number): CSSProperties {
  const bottom = "var(--pane-pad-bottom, 0px)";
  return { position: "sticky", bottom: `calc(-1 * ${bottom})`, marginBottom: `calc(-1 * ${bottom})`, paddingBottom: `calc(${pad}px + ${bottom})` };
}
