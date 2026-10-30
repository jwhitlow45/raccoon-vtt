import { createElement, type CSSProperties } from "react";
import { useSheetHandle } from "../features/device/settings.ts";
import { GRABBER_TRANSITION_VAR, HELD_COLOR_VAR, PULL_VAR, SLIDE_MS, STRETCH_VAR } from "../lib/sheetSwipe.ts";
import { theme } from "../lib/theme.ts";
import { grabberDesign, grabberRoom, GRABBER_TOP, type GrabberDesign } from "./grabberDesigns.ts";

/** Marks the grabber, for the checks that every sheet that swipes shows exactly one. */
export const GRABBER_ATTR = "data-sheet-grabber";

/**
 * The room a header keeps above its first line where it holds the
 * grabber, for the design this device chose (grabberRoom): every host of
 * the grabber reads it here, so a new choice moves each header's buttons
 * down or up by the same amount at once, and nothing else in it.
 */
export function useGrabberRoom(): number {
  return grabberRoom(useSheetHandle());
}

/**
 * The grabber centered at the top of a phone's sheet that swipes
 * (docs/design-v1-sheet-swipe.md), as video apps draw over their comments:
 * it shows that the sheet can be swiped, in the design This device chose
 * (4.8). A host draws it only inside a grab area that swipes, so the
 * grabber and the swipe share one condition (SheetHeader's and
 * PaneHeader's `grab`, the roll card's header, the X-card's body).
 *
 * It is decoration, laid over the room above the header's first line, so
 * it moves nothing there. Its containing box is the grab area, which
 * starts at the surface's top edge, reaching over the surface's own top
 * padding where it has one, so the grabber is always on it and a touch
 * there moves the surface as one on the header does. A header with less
 * room than useGrabberRoom above its buttons grows its top padding by the
 * difference. The X-card has no header, and its grabber sits on the
 * content that it swipes by. It takes no pointer, so a touch on it lands
 * on what lies under it, and a tap beside it still reaches Back or Close.
 *
 * The host's custom properties mix the member's color with controlBorder
 * and stretch the drawing with the pull, without a render or header move.
 * Reduced motion keeps the stretch at zero and cuts the color's fade.
 * Forced colors would trade the color for the system's text color, so
 * globals.css gives it GrayText at rest and Highlight while held there.
 */
export function SheetGrabber() {
  const design = grabberDesign(useSheetHandle());
  return (
    <GrabberDrawing
      design={design}
      attrs={{ [GRABBER_ATTR]: "" }}
      style={{
        position: "absolute",
        top: GRABBER_TOP,
        left: "50%",
        marginLeft: -design.width / 2,
        color: `color-mix(in srgb, var(${HELD_COLOR_VAR}, ${theme.color.controlBorder}) calc(30% + var(${PULL_VAR}, 0) * 70%), ${theme.color.controlBorder})`,
        transform: `scale(calc(1 + var(${STRETCH_VAR}, 0) * 0.4), calc(1 - var(${STRETCH_VAR}, 0) * 0.25))`,
        transformOrigin: "center",
        transition: `var(${GRABBER_TRANSITION_VAR}, color ${SLIDE_MS}ms ease, transform ${SLIDE_MS}ms cubic-bezier(0.34, 1.56, 0.64, 1))`,
        pointerEvents: "none",
      }}
    />
  );
}

/** A design drawn at its real size in one color, `currentColor`: the grabber itself, and its preview in This device. */
export function GrabberDrawing(props: { design: GrabberDesign; style?: CSSProperties; attrs?: Record<string, string> }) {
  const { design } = props;
  return (
    <svg
      aria-hidden
      {...props.attrs}
      data-grabber-design={design.id}
      width={design.width}
      height={design.height}
      viewBox={`0 0 ${design.width} ${design.height}`}
      fill="currentColor"
      fillRule={design.evenOdd ? "evenodd" : undefined}
      style={{ display: "block", flex: "none", ...props.style }}
    >
      {design.shapes.map(([tag, shape], i) => createElement(tag, { key: i, ...shape }))}
    </svg>
  );
}
