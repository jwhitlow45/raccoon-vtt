import { theme } from "../lib/theme.ts";

/** The pill's size in layout px, which the interface size scales as it scales the header around it. */
export const GRABBER = { width: 36, height: 4 } as const;

/** Marks the pill, for the checks that every sheet that swipes shows exactly one. */
export const GRABBER_ATTR = "data-sheet-grabber";

/**
 * The short pill centered at the top of a phone's sheet that swipes
 * (docs/design-v1-sheet-swipe.md), as video apps draw over their comments:
 * it shows that the sheet can be swiped. A host draws it only inside a
 * grab area that swipes, so the pill and the swipe share one condition
 * (SheetHeader's and PaneHeader's `grab`, the roll card's header, the
 * X-card's body).
 *
 * It is decoration, laid over the room above the header's first line and
 * centered in it, so it adds no height and moves nothing. `space` is that
 * room in layout px, and `from` where it starts below the pill's
 * containing box, negative where it lies above that box in the surface's
 * own padding. It takes no pointer, so a touch on it lands on the header
 * under it, and a tap beside it still reaches Back or Close.
 *
 * Forced colors drop its fill, so globals.css gives it a system color
 * there.
 */
export function SheetGrabber(props: { space: number; from?: number }) {
  return (
    <span
      aria-hidden
      {...{ [GRABBER_ATTR]: "" }}
      style={{
        position: "absolute",
        top: (props.from ?? 0) + (props.space - GRABBER.height) / 2,
        left: "50%",
        width: GRABBER.width,
        height: GRABBER.height,
        marginLeft: -GRABBER.width / 2,
        borderRadius: theme.radius.pill,
        background: theme.color.controlBorder,
        pointerEvents: "none",
      }}
    />
  );
}
