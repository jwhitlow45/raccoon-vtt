import { useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { layoutWidth } from "../features/device/layout.ts";
import { useBackClose } from "../lib/backClose.ts";
import { useModalDialog } from "../lib/modalDialog.ts";
import { theme } from "../lib/theme.ts";
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
};

function widthPx(width: DialogWidth): number {
  return typeof width === "number" ? width : theme.layout.dialog[width];
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
 */
export function Dialog(props: DialogProps) {
  const { onClose, phone: phoneMode = "fill", header = true } = props;
  const phone = typeof window !== "undefined" && layoutWidth() < DIALOG_PHONE_MAX;
  const sheet = phoneMode === "sheet";
  const dialog = useRef<HTMLDialogElement>(null);
  useBackClose(props.backClose === true, onClose);
  useModalDialog(dialog, { onClose, ...(props.opener ? { returnFocus: props.opener } : null), ...(props.zoom === false ? { zoom: false } : null) });

  const card: CSSProperties = phone
    ? sheet
      ? {
          width: "100%",
          maxHeight: "92%",
          borderRadius: `${theme.radius.lg}px ${theme.radius.lg}px 0 0`,
          paddingBottom: theme.safe.bottom,
          paddingLeft: theme.safe.left,
          paddingRight: theme.safe.right,
        }
      : {
          width: "100%",
          height: "100%",
          borderRadius: 0,
          paddingTop: theme.safe.top,
          paddingBottom: theme.safe.bottom,
          paddingLeft: theme.safe.left,
          paddingRight: theme.safe.right,
        }
    : {
        width: `min(${widthPx(props.width ?? "md")}px, calc(100% - ${theme.space(8)}px))`,
        // An editor keeps one height while its tabs and sections change. A picker fits what it shows.
        ...(sheet ? { maxHeight: `min(88%, 760px)` } : { height: `min(calc(100% - ${theme.space(8)}px), 760px)` }),
        borderRadius: theme.radius.lg,
      };

  // The dialog element is the dimmed layer over the whole screen, so a tap on it outside the card closes the card.
  return createPortal(
    <dialog
      ref={dialog}
      aria-modal="true"
      aria-label={props.title}
      tabIndex={-1}
      onClick={(e) => {
        if (props.dismissOnBackdrop !== false && e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        maxWidth: "none",
        maxHeight: "none",
        margin: 0,
        padding: 0,
        border: "none",
        display: "flex",
        alignItems: phone && sheet ? "flex-end" : "center",
        justifyContent: "center",
        background: props.scrim ?? theme.color.scrim,
        fontFamily: theme.font.body,
        color: theme.color.text,
        outline: "none",
        overflow: "hidden",
      }}
    >
      <section
        style={{
          display: "flex",
          flexDirection: "column",
          background: theme.color.surface,
          border: `${theme.line.border}px solid ${theme.color.border}`,
          boxShadow: theme.shadow.dialog,
          overflow: "hidden",
          ...card,
        }}
      >
        {header ? <SheetHeader title={props.title} back={props.back} actions={props.headerActions} onClose={onClose} divider /> : null}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", padding: theme.space(4), ...props.bodyStyle }}>{props.children}</div>
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
              <span style={{ flex: "1 1 160px", minWidth: 0, fontSize: theme.font.small, color: theme.color.textMuted, lineHeight: theme.leading.body }}>{props.status}</span>
            ) : null}
            {props.footer}
          </footer>
        ) : null}
      </section>
    </dialog>,
    document.body,
  );
}
