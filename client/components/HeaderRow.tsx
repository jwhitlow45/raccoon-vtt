import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { theme } from "../lib/theme.ts";
import { buttonLook } from "./looks.ts";

/**
 * The side panel's header rows (docs/design-v1-side-headers.md): the party
 * line, each pane's tab row or bar, and a subpage's header. One look for
 * all of them, so the panel below reads as the same kind of thing as the
 * one on top: a line of 44 px targets with a 1 px rule at its foot and no
 * padding above or below, which is where the rows lost their room.
 *
 * A control with a shape of its own (a chosen tab, a party chip, Ask)
 * draws it as a 32 px pill centered in its 44 px target, so its outline
 * never meets the rules above and below. Its focus ring is drawn on the
 * pill (globals.css `[data-pill-focus]`), so it hugs the shape and stays
 * inside a strip that scrolls and clips.
 */

/** The pill's height, and the room above and below it inside a 44 px target. */
export const PILL_HEIGHT = 32;
export const PILL_INSET = (theme.touch - PILL_HEIGHT) / 2;

/** Marks a control whose focus ring goes on its pill, and the pill itself. */
export const PILL_FOCUS = { "data-pill-focus": "" } as const;

/**
 * A header row. `raised` for a pane's own header (the tab row and the bar
 * between two panes), which reads as a band over the pane's body. The
 * party line and a subpage's header sit on the panel's surface.
 */
export function headerRow(raised: boolean): CSSProperties {
  return {
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    gap: theme.space(1),
    minHeight: theme.touch + theme.line.border,
    padding: `0 ${theme.space(2)}px`,
    background: raised ? theme.color.surfaceRaised : theme.color.surface,
    borderBottom: `${theme.line.border}px solid ${theme.color.border}`,
  };
}

/**
 * What a control with a pill needs: a stacking context of its own, so the
 * pill paints over the control's background and under its words.
 */
export const PILL_HOST: CSSProperties = { position: "relative", isolation: "isolate" };

/**
 * The pill behind a control's content, taking no room, so a tab's width is
 * its text's alone and the tab fit reads nothing new. It holds what sits
 * on the shape's corner or foot: a count's badge, the bottom panel's mark.
 * It comes last in its control (PILL_HOST), so a badge's hidden words
 * follow the title in the control's name: "Log 2 unread".
 */
export function Pill(props: { look?: CSSProperties | null; children?: ReactNode }) {
  return (
    <span
      data-pill=""
      style={{
        position: "absolute",
        zIndex: -1,
        left: 0,
        right: 0,
        top: PILL_INSET,
        bottom: PILL_INSET,
        boxSizing: "border-box",
        borderRadius: theme.radius.md,
        border: `${theme.line.border}px solid transparent`,
        pointerEvents: "none",
        ...props.look,
      }}
    >
      {props.children}
    </span>
  );
}

/**
 * A secondary button in a header row, such as Ask on the party line: its
 * fill and outline on the pill, its 44 px target around it.
 */
export function PillButton(props: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "style"> & { style?: CSSProperties }) {
  const { children, style, ...rest } = props;
  const look = buttonLook("secondary");
  return (
    <button
      type="button"
      {...PILL_FOCUS}
      {...rest}
      style={{
        ...PILL_HOST,
        flex: "none",
        minWidth: theme.touch,
        minHeight: theme.touch,
        padding: `0 ${theme.space(3)}px`,
        border: "none",
        background: "transparent",
        color: look.color,
        fontFamily: theme.font.body,
        fontSize: theme.font.body14,
        fontWeight: theme.weight.strong,
        whiteSpace: "nowrap",
        cursor: "pointer",
        ...style,
      }}
    >
      {children}
      <Pill look={{ background: look.background, border: look.border }} />
    </button>
  );
}
