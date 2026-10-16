import type { PointerEvent as ReactPointerEvent, ReactNode, Ref } from "react";
import { theme } from "../lib/theme.ts";
import { Icon } from "./Icon.tsx";
import { IconButton } from "./IconButton.tsx";
import { dangerLook } from "./looks.ts";

/**
 * Where a header's back button leads. `label` is its accessible name,
 * "Back to" and the parent's name ("Back to Menu"), while its visible
 * content is the back icon only.
 *
 * `armed` is a question the back button asks before it leaves, such as
 * "Discard changes?" in the encounter editor: while set, the button shows
 * it beside the icon in the armed danger look, and it becomes the name, so
 * what a screen reader hears is what the tap will confirm.
 */
export type HeaderBack = { label: string; onBack(): void; armed?: string | null };

const TITLE_STYLE = {
  flex: 1,
  // A few letters stay when the trailing actions crowd the row, as the top bar's room name does.
  minWidth: 40,
  margin: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

/**
 * The one header of sheets, dialogs and panel subpages
 * (docs/design-v1-visual.md 2.3): a 56 px row with an optional back
 * button, the title at 18 px weight 700, optional trailing actions, and
 * the close button. A header without a back button indents its title to
 * the body's text, so the two line up.
 *
 * `actions` sit between the title and the close button, such as the
 * folded token bar and the alerts summary when the dock has no room
 * (3.2.1). The title then shrinks first, and the row's side padding halves,
 * so Back, the title's few letters, both actions and the close fit a
 * 320 px phone at 130%: 240 layout px, where the sheet has 244.
 *
 * While the back button asks its question ("Discard changes?"), the
 * question takes the title's place, and any actions step aside until it
 * is answered or put away. A question beside the title and the actions
 * ran past the sheet's edge on a small phone, and the close with it. The
 * title stays in the page, hidden, so the sheet keeps its name.
 */
export function SheetHeader(props: {
  title: ReactNode;
  /** For `aria-labelledby` on the sheet or dialog. */
  titleId?: string;
  /** The heading's level, 2 unless the header sits inside another titled region. */
  level?: 2 | 3;
  back?: HeaderBack | null;
  actions?: ReactNode;
  onClose?(): void;
  /** The close button's name. "Close" and the title by default, so every close a test or a screen reader meets starts with "Close". */
  closeLabel?: string;
  backRef?: Ref<HTMLButtonElement>;
  closeRef?: Ref<HTMLButtonElement>;
  /**
   * The heading, which can take focus from script (`tabIndex={-1}`) but is
   * no Tab stop: entering a panel's subpage moves focus here
   * (features/panels.ts useSubpageFocus).
   */
  titleRef?: Ref<HTMLHeadingElement>;
  /** A line under the header, for a dialog whose body scrolls under it. */
  divider?: boolean;
  /**
   * Hide, for a sheet on the right of a phone held sideways
   * (docs/design-v1-layout-hierarchy.md 4.2): between the actions and the
   * close, named by the panel as the close is ("Hide Initiative").
   */
  onHide?(): void;
  hideLabel?: string;
  /**
   * Two rows where one would not fit its buttons and a few letters of the
   * title (sheetCap.ts headerStacks): Back at the left and the other
   * buttons at the right, then the title alone on one line. 78 px in all.
   */
  stacked?: boolean;
}) {
  const { back, level = 2 } = props;
  const Heading = level === 2 ? "h2" : "h3";
  const asking = !!back?.armed;
  const actions = asking ? null : props.actions;
  const closeLabel = props.closeLabel ?? (typeof props.title === "string" ? `Close ${props.title}` : "Close");
  const backButton = back ? <BackButton back={back} ref={props.backRef} /> : null;
  const trailing = (
    <>
      {actions}
      {props.onHide ? <IconButton icon="chevronRight" label={props.hideLabel ?? "Hide"} onClick={props.onHide} style={asking && !props.stacked ? { marginLeft: "auto" } : undefined} /> : null}
      {props.onClose ? <IconButton ref={props.closeRef} icon="close" label={closeLabel} onClick={props.onClose} style={asking && !props.onHide && !props.stacked ? { marginLeft: "auto" } : undefined} /> : null}
    </>
  );
  const heading = (stacked: boolean) => (
    <Heading
      ref={props.titleRef}
      id={props.titleId}
      tabIndex={-1}
      hidden={asking}
      style={{
        ...TITLE_STYLE,
        paddingLeft: back && !stacked ? 0 : theme.space(2),
        fontSize: theme.font.heading,
        fontWeight: theme.weight.bold,
        lineHeight: stacked ? `${STACKED_TITLE_LINE}px` : theme.leading.tight,
      }}
    >
      {props.title}
    </Heading>
  );
  const padding = theme.space(actions ? 1 : 2);
  const divider = props.divider ? `${theme.line.border}px solid ${theme.color.border}` : undefined;
  if (props.stacked) {
    return (
      <header style={{ flex: "none", display: "flex", flexDirection: "column", minWidth: 0, padding: `${STACKED_PAD}px ${padding}px`, borderBottom: divider }}>
        <div style={{ display: "flex", alignItems: "center", gap: theme.space(1), minWidth: 0, height: theme.touch }}>
          {backButton}
          <span style={{ flex: 1 }} />
          {trailing}
        </div>
        {heading(true)}
      </header>
    );
  }
  return (
    <header
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: theme.space(1),
        // A row that never wraps would otherwise ask its parent for the title's whole width, before the title's ellipsis can act.
        minWidth: 0,
        minHeight: 56,
        padding: `0 ${padding}px`,
        borderBottom: divider,
      }}
    >
      {backButton}
      {heading(false)}
      {trailing}
    </header>
  );
}

/** The stacked header's padding above and below, and its title's line: 6 + 44 + 22 + 6 = 78 px (sheetCap.ts SHEET_HEADER_STACKED). */
const STACKED_PAD = 6;
const STACKED_TITLE_LINE = 22;

/**
 * One `<button>` in both states, so arming it changes its content, name
 * and look but keeps the element, and keyboard focus stays on it: the
 * Enter that arms is followed by the Enter that confirms. As two elements
 * (an IconButton, then a text button) React replaced the node, and focus
 * fell to the page.
 */
function BackButton(props: { back: HeaderBack; ref?: Ref<HTMLButtonElement> }) {
  const { back } = props;
  const armed = back.armed ? back.armed : null;
  return (
    <button
      ref={props.ref}
      type="button"
      aria-label={armed ?? back.label}
      title={armed ?? back.label}
      onClick={back.onBack}
      style={{
        flex: "none",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: theme.space(1),
        minWidth: theme.touch,
        minHeight: theme.touch,
        padding: armed ? `0 ${theme.space(3)}px 0 ${theme.space(2)}px` : 0,
        borderRadius: theme.radius.md,
        fontFamily: theme.font.body,
        fontSize: theme.font.body14,
        fontWeight: theme.weight.strong,
        whiteSpace: "nowrap",
        cursor: "pointer",
        ...(armed
          ? { background: "transparent", ...dangerLook(true) }
          : { background: "transparent", border: `${theme.line.border}px solid transparent`, color: theme.color.textMuted }),
      }}
    >
      <Icon name="back" />
      {armed}
    </button>
  );
}

/**
 * What makes a pane's header a handle to move the pane by (the docked
 * token action bar, canvas/TokenActionBar.tsx): the pointer handlers on
 * its row, and whether a drag is under way, for the cursor.
 */
export type PaneHandle = {
  dragging: boolean;
  onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void;
  onPointerMove(e: ReactPointerEvent<HTMLDivElement>): void;
  onPointerUp(e: ReactPointerEvent<HTMLDivElement>): void;
  onPointerCancel(e: ReactPointerEvent<HTMLDivElement>): void;
};

/**
 * The header of a pane over the map (docs/design-v1-visual.md 2.3): the
 * token action bar, the label, pin and light panes, the door card and the
 * stop note. One 48 px row, the title at 16 px weight 700 and a close
 * button, so no pane needs negative margins to tuck its close into a
 * corner. The close is named "Close" unless the pane says more ("Close
 * without saving").
 *
 * The token action bar asks for three more (docs/design-v1-bar-dock.md):
 * `handle` makes the row the pane's handle, with a grip at its start and
 * no scrolling or zooming under a finger on it. `sticky` keeps the row at
 * the top of the pane's scrolling frame on an opaque fill that reaches
 * across the frame's 12 px side padding, so the handle and the close never
 * scroll away. `lines` lets the title wrap to that many lines before it
 * is cut short.
 */
export function PaneHeader(props: {
  title: ReactNode;
  titleId?: string;
  onClose?(): void;
  closeLabel?: string;
  closeRef?: Ref<HTMLButtonElement>;
  /** Between the title and the close button. */
  actions?: ReactNode;
  handle?: PaneHandle;
  sticky?: boolean;
  lines?: number;
}) {
  const { handle, sticky, lines } = props;
  return (
    <div
      onPointerDown={handle?.onPointerDown}
      onPointerMove={handle?.onPointerMove}
      onPointerUp={handle?.onPointerUp}
      onPointerCancel={handle?.onPointerCancel}
      style={{
        display: "flex",
        alignItems: "center",
        gap: theme.space(1),
        minWidth: 0,
        minHeight: 48,
        ...(handle ? { touchAction: "none", cursor: handle.dragging ? "grabbing" : "grab" } : null),
        ...(sticky
          ? {
              position: "sticky",
              top: 0,
              zIndex: 1,
              // The frame's 4 px top padding and 12 px side padding, taken back so the fill covers what scrolls under it.
              margin: `-${theme.space(1)}px -${theme.space(3)}px 0`,
              padding: `${theme.space(1)}px ${theme.space(3)}px 0`,
              background: theme.color.surface,
            }
          : null),
      }}
    >
      {handle ? <Grip /> : null}
      <strong
        id={props.titleId}
        style={{
          ...TITLE_STYLE,
          fontSize: theme.font.input,
          fontWeight: theme.weight.bold,
          lineHeight: theme.leading.tight,
          ...(lines ? { display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", whiteSpace: "normal", overflowWrap: "anywhere" } : null),
        }}
      >
        {props.title}
      </strong>
      {props.actions}
      {props.onClose ? <IconButton ref={props.closeRef} icon="close" label={props.closeLabel ?? "Close"} onClick={props.onClose} /> : null}
    </div>
  );
}

/** Six dots, the usual sign that a row moves what it heads. Decoration only: the pane's name and its Move bar button say the rest. */
function Grip() {
  return (
    <svg aria-hidden viewBox="0 0 12 20" width={12} height={20} style={{ flex: "none", display: "block", color: theme.color.textMuted }}>
      {[4, 10, 16].flatMap((y) => [3, 9].map((x) => <circle key={`${x}:${y}`} cx={x} cy={y} r={1.6} fill="currentColor" />))}
    </svg>
  );
}
