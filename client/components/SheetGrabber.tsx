import { theme } from "../lib/theme.ts";

/**
 * The pill in layout px, which the interface size scales as it scales the
 * header around it: its size, and its place 5 px under the surface's top
 * edge, inside its 1 px border, so it has visible room above it.
 */
export const GRABBER = { width: 36, height: 4, top: 5 } as const;

/**
 * The room a header keeps above its first line where it holds the pill:
 * the pill's place, its height and 1 px clear of the buttons under it, so
 * it never touches the dock's outlined chip, an armed Back or Close.
 */
export const GRABBER_ROOM = GRABBER.top + GRABBER.height + 1;

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
 * It is decoration, laid over the room above the header's first line, so
 * it moves nothing there. A header with less room than GRABBER_ROOM above
 * its buttons grows its top padding by the difference. `from` is where the
 * surface's top edge lies below the pill's containing box, negative where
 * that box starts lower, in the surface's own padding. It takes no
 * pointer, so a touch on it lands on the header under it, and a tap
 * beside it still reaches Back or Close.
 *
 * Forced colors drop its fill, so globals.css gives it a system color
 * there.
 */
export function SheetGrabber(props: { from?: number }) {
  return (
    <span
      aria-hidden
      {...{ [GRABBER_ATTR]: "" }}
      style={{
        position: "absolute",
        top: (props.from ?? 0) + GRABBER.top,
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
