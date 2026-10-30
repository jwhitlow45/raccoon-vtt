import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { layoutWidth } from "../features/device/layout.ts";
import { useUiScale } from "../features/device/settings.ts";
import { useBackClose } from "../lib/backClose.ts";
import { bodyHoldsField, useFieldInView, useKeyboardView } from "../lib/keyboardInset.ts";
import { useModalDialog } from "../lib/modalDialog.ts";
import { DraftScope, useDraftRegistry, useSheetSwipe } from "../lib/sheetSwipe.ts";
import { theme } from "../lib/theme.ts";
import { RowHintScope } from "./Field.tsx";
import { SheetGrabber } from "./SheetGrabber.tsx";
import { SheetHeader, type HeaderBack } from "./SheetHeader.tsx";

/** Below this layout width a dialog takes a phone's shape: the whole screen, or a sheet from the bottom. */
export const DIALOG_PHONE_MAX = 600;

export type DialogWidth = keyof typeof theme.layout.dialog | number;

export type DialogProps = {
  /** The dialog's accessible name and its header's title. */
  title: string;
  onClose(): void;
  children: ReactNode;
  /** The buttons at the foot: Cancel (secondary) then the main action (primary), at the right. */
  footer?: ReactNode;
  /** A short line at the footer's left: what the main button will do, or why it cannot yet. */
  status?: ReactNode;
  /**
   * The footer's buttons grow to share the line they stand on
   * (docs/design-v1-polish.md R6), so the status takes the line's spare
   * room ahead of them: a button beside it keeps its own width, and one
   * that wraps under it fills its line. Off, the status and the buttons
   * share spare room as they always have.
   */
  statusGrow?: boolean;
  /** The card's width on a computer: `layout.dialog.sm`, `md` or `lg`. */
  width?: DialogWidth;
  /**
   * The shape on a phone. `fill` takes the whole screen, for editors with
   * many fields. `sheet` rises from the bottom and fits its content, for
   * short pickers. On a computer `fill` keeps one height while its content
   * changes, and `sheet` fits its content there too.
   */
  phone?: "fill" | "sheet";
  /** The backdrop. `theme.color.scrim` by default. The handout keeps a deeper one, since a dim map helps read it. */
  scrim?: string;
  /** False leaves out the title row, for the X-card, whose card is its own message. The title still names the dialog. */
  header?: boolean;
  /** A back button in the header, for a dialog that is a step of another. */
  back?: HeaderBack | null;
  /** Between the title and the close button. */
  headerActions?: ReactNode;
  /** Lines under the title inside the header, such as the handout viewer's details (SheetHeader `detail`). They describe the dialog, so a screen reader hears them as it opens. */
  headerDetail?: ReactNode;
  /** Where focus returns on close, when not to whatever had it as the dialog opened. */
  opener?: RefObject<HTMLElement | null>;
  /** Android's Back closes the dialog (lib/backClose.ts) rather than leaving the room. */
  backClose?: boolean;
  /** False keeps the dialog at 100% whatever the interface size, for one with pointer math of its own (lib/modalDialog.ts). */
  zoom?: boolean;
  /** A tap on the backdrop beside the card closes the dialog. On by default. */
  dismissOnBackdrop?: boolean;
  /** For the scrolling body, such as a smaller font or no padding. */
  bodyStyle?: CSSProperties;
  /**
   * The phone's whole-screen card at any width, for the handout viewer: a
   * short layout, where a card would leave a sliver of dim room around it,
   * and its states that fill the window (features/handouts/HandoutViewer.tsx).
   */
  full?: boolean;
};

/** The scrolling body's padding, which `PINNED_FOOT` reaches into. */
const BODY_PAD = theme.space(4);

/** The footer status's share of its line's spare room under `statusGrow`, so far over a button's 1 that a button beside it grows by less than a pixel. */
const STATUS_GROW = 999;

/**
 * A row at the end of a dialog's body that stays in view while the body
 * scrolls, such as a picker's chosen picture and its Use, which a phone
 * held sideways or a large interface size would otherwise leave under the
 * fold: stuck to the body's foot over what scrolls under it, and where it
 * would sit anyway once the body reaches its end. Its padding reaches into
 * the gap above it and the body's padding below, so it draws the same
 * either way, on a ground that hides what passes under it.
 */
export const PINNED_FOOT: CSSProperties = {
  position: "sticky",
  bottom: 0,
  zIndex: 1,
  background: theme.color.surface,
  paddingTop: theme.space(2),
  marginTop: -theme.space(2),
  paddingBottom: BODY_PAD,
  marginBottom: -BODY_PAD,
};

function widthPx(width: DialogWidth): number {
  return typeof width === "number" ? width : theme.layout.dialog[width];
}

/** The card's shape at a layout width: a sheet from the bottom, the whole screen, or a card in the middle. */
export function dialogCard(layoutPx: number, props: Pick<DialogProps, "phone" | "width" | "full">): { card: CSSProperties; bottom: boolean } {
  const phone = layoutPx < DIALOG_PHONE_MAX;
  const sheet = props.phone === "sheet";
  if (props.full || (phone && !sheet)) {
    return {
      card: {
        width: "100%",
        height: "100%",
        // At the screen's edges a border frames nothing, and takes 2 px from a short screen.
        border: "none",
        borderRadius: 0,
        paddingTop: theme.safe.top,
        paddingBottom: theme.safe.bottom,
        paddingLeft: theme.safe.left,
        paddingRight: theme.safe.right,
      },
      bottom: false,
    };
  }
  if (phone) {
    return {
      card: {
        width: "100%",
        maxHeight: "92%",
        borderRadius: `${theme.radius.lg}px ${theme.radius.lg}px 0 0`,
        paddingBottom: theme.safe.bottom,
        paddingLeft: theme.safe.left,
        paddingRight: theme.safe.right,
      },
      bottom: true,
    };
  }
  return {
    card: {
      width: `min(${widthPx(props.width ?? "md")}px, calc(100% - ${theme.space(8)}px))`,
      // An editor keeps one height while its tabs and sections change. A picker fits what it shows.
      ...(sheet ? { maxHeight: `min(88%, 760px)` } : { height: `min(calc(100% - ${theme.space(8)}px), 760px)` }),
      borderRadius: theme.radius.lg,
    },
    bottom: false,
  };
}

/**
 * The one dialog shell (docs/design-v1-visual.md 2.3): a modal `<dialog>`
 * opened with showModal (lib/modalDialog.ts), so the room behind it is
 * inert, Escape and the close button close it, and focus goes back to
 * what opened it. It renders into document.body, clear of the sheets and
 * the canvas.
 *
 * Its structure is a contract that e2e/size.e2e.ts checks for every
 * dialog: the card is the dialog's first `section`, one direct child of
 * that section scrolls (up and down only), the header is SheetHeader with
 * a close button whose name starts with "Close", and the footer's buttons
 * sit in a `footer` element.
 *
 * The card is sized by shares of the dialog, which covers the screen,
 * never by viewport units: the dialog takes the interface size with CSS
 * `zoom`, which multiplies viewport units too, and a card of `100dvh` ran
 * off a phone at 130% with its Save button out of reach
 * (features/device/layout.ts).
 *
 * The bottom card swipes down to close (lib/sheetSwipe.ts): from its
 * header, or from anywhere once its body is at its top. It provides its
 * body the context that reports unsaved input, which makes a swipe spring
 * back instead.
 *
 * While the on-screen keyboard is open (lib/keyboardInset.ts) the dialog
 * covers only what shows above it, so a sheet from the bottom stands on
 * the keyboard and a whole-screen card ends there, and the field with
 * focus scrolls into view in the body with its form. Where the body is
 * then too short for the field and what goes with it, as on a phone held
 * sideways at 130%, the card takes all of what shows and its header steps
 * out of sight (the dialog keeps its name), so the field and the footer's
 * buttons show together, until the keyboard closes.
 */
export function Dialog(props: DialogProps) {
  const { onClose, header = true } = props;
  // On the server's render, with no window, the computer's card.
  const { card: cardStyle, bottom } = dialogCard(typeof window === "undefined" ? DIALOG_PHONE_MAX : layoutWidth(), props);
  const dialog = useRef<HTMLDialogElement>(null);
  const detailId = useId();
  useBackClose(props.backClose === true, onClose);
  useModalDialog(dialog, { onClose, ...(props.opener ? { returnFocus: props.opener } : null), ...(props.zoom === false ? { zoom: false } : null) });
  useStepFocus(dialog, props.title);
  const card = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const drafts = useDraftRegistry();
  const deviceScale = useUiScale();
  const scale = props.zoom === false ? 1 : deviceScale;
  const view = useKeyboardView();
  // Decided once the body has laid out over the keyboard, and kept until it closes, so nothing moves under a finger on its way to Add.
  const [cramped, setCramped] = useState(false);
  useLayoutEffect(() => {
    if (view === null) setCramped(false);
    else if (!cramped && body.current && bodyHoldsField(body.current, theme.space(2)) === false) setCramped(true);
  }, [view, cramped]);
  const tight = cramped && view !== null;
  useFieldInView(body, useMemo(() => ({ view, tight }), [view, tight]), theme.space(2));
  // Its title names its step, as the scene menu's do, so a new step ends a drag.
  useSheetSwipe(card, { enabled: bottom, onClose, scroller: body, item: props.title, clip: "screen", drafts });
  const headlessSheet = bottom && !header;

  // The dialog element is the dimmed layer over the whole screen, so a tap on it outside the card closes the card.
  return createPortal(
    <dialog
      ref={dialog}
      aria-modal="true"
      aria-label={props.title}
      aria-describedby={header && props.headerDetail ? detailId : undefined}
      tabIndex={-1}
      onClick={(e) => {
        if (props.dismissOnBackdrop !== false && e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        // The dialog's own px are zoomed by the interface size (useModalDialog), and the keyboard's are the page's.
        inset: view ? `${view.top / scale}px 0 ${view.inset / scale}px` : 0,
        width: "100%",
        height: view ? "auto" : "100%",
        maxWidth: "none",
        maxHeight: "none",
        margin: 0,
        padding: 0,
        border: "none",
        display: "flex",
        alignItems: bottom ? "flex-end" : "center",
        justifyContent: "center",
        background: props.scrim ?? theme.color.scrim,
        fontFamily: theme.font.body,
        color: theme.color.text,
        outline: "none",
        overflow: "hidden",
      }}
    >
      <section
        ref={card}
        style={{
          display: "flex",
          flexDirection: "column",
          background: theme.color.surface,
          border: `${theme.line.border}px solid ${theme.color.border}`,
          boxShadow: theme.shadow.dialog,
          overflow: "hidden",
          ...cardStyle,
          ...(tight ? { alignSelf: "stretch", height: "auto", maxHeight: "none" } : null),
        }}
      >
        {header && !tight ? <SheetHeader title={props.title} back={props.back} actions={props.headerActions} detail={props.headerDetail} detailId={detailId} onClose={onClose} divider grab={bottom} /> : null}
        <div ref={body} style={{ flex: 1, minHeight: 0, overflowY: "auto", scrollbarGutter: "stable", overscrollBehavior: "contain", padding: BODY_PAD, ...props.bodyStyle, ...(headlessSheet ? { position: "relative" } : null) }}>
          {/* With no header to hold it, the X-card's grabber sits at the top of its body, all it has to swipe by, in the 20 px its content keeps above its first line. */}
          {headlessSheet ? <SheetGrabber /> : null}
          <DraftScope value={drafts}>
            <RowHintScope>{props.children}</RowHintScope>
          </DraftScope>
        </div>
        {props.footer || props.status ? (
          <footer
            style={{
              flex: "none",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: theme.space(2),
              padding: theme.space(3),
              borderTop: `${theme.line.border}px solid ${theme.color.border}`,
            }}
          >
            {props.status ? (
              <span style={{ flex: `${props.statusGrow ? STATUS_GROW : 1} 1 160px`, minWidth: 0, fontSize: theme.font.small, color: theme.color.textMuted, lineHeight: theme.leading.body }}>{props.status}</span>
            ) : null}
            {props.footer}
          </footer>
        ) : null}
      </section>
    </dialog>,
    document.body,
  );
}

/**
 * "Throw away your changes?", in an editor's status line once its close
 * asks before it discards (the journal's and the monster's editors). It is
 * an alert, so a screen reader hears the question as it appears: an
 * Escape asks it, and a second Escape discards, which must never happen
 * unheard.
 */
export function DiscardQuestion() {
  return (
    <span role="alert" style={{ fontSize: theme.font.body14, color: theme.color.text }}>
      Throw away your changes?
    </span>
  );
}

/**
 * A dialog that moves to another step in place, such as a scene menu's
 * Duplicate and Move to folder, swaps its body under the same `<dialog>`,
 * and the row or back button that had focus goes with it. Focus then fell
 * to the page under a modal dialog, and a screen reader heard nothing of
 * the new step. The dialog takes focus as it does when it opens, which
 * reads out its new title. A title that changes while focus stays inside,
 * such as a page renamed from another device, moves nothing.
 */
function useStepFocus(dialog: RefObject<HTMLDialogElement | null>, title: string): void {
  const shown = useRef(title);
  useLayoutEffect(() => {
    if (shown.current === title) return;
    shown.current = title;
    const el = dialog.current;
    const active = document.activeElement;
    if (el?.open && (active === null || active === document.body)) el.focus({ preventScroll: true });
  }, [dialog, title]);
}
