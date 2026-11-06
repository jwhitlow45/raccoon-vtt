import { createElement, type CSSProperties } from "react";
import { useSheetHandle } from "../features/device/settings.ts";
import { useFinePointer } from "../lib/device.ts";
import { DRAG_BAND_ATTR, GRABBER_TRANSITION_VAR, HELD_COLOR_VAR, PULL_VAR, SLIDE_MS, STRETCH_VAR, type SheetControls } from "../lib/sheetSwipe.ts";
import { theme } from "../lib/theme.ts";
import { grabberDesign, grabberRoom, GRABBER_TOP, heldShare, STRETCH_X, STRETCH_Y, type GrabberDesign } from "./grabberDesigns.ts";
import { Icon } from "./Icon.tsx";
import { PILL_FOCUS } from "./HeaderRow.tsx";
import { useTooltip } from "./Tooltip.tsx";

/** Marks the grabber, for the checks that every sheet that swipes shows exactly one. */
export const GRABBER_ATTR = "data-sheet-grabber";

/** The strip the step arrows stand in, one touch target tall, at the top of a grab area (docs/design/design-v1-panel-size.md 5.2). */
export const ARROW_STRIP = theme.touch;
/** Each arrow's drawn pill inside its 44 px target. */
const ARROW_PILL = { width: 32, height: 24 } as const;
/** The drag band reaches this far past the grabber on each side, up to the arrows. */
const BAND_PAD = 4;

/**
 * Whether a grab area shows the step arrows: where its surface's controls
 * reach it and a mouse or trackpad is at hand (5.1). A phone's finger
 * swipes, so its header stays as it was.
 */
export function useSheetArrows(controls?: SheetControls | null): boolean {
  const fine = useFinePointer();
  return !!controls && fine;
}

/**
 * The room a header keeps above its first line where it holds the
 * grabber, for the design this device chose (grabberRoom): every host of
 * the grabber reads it here, so a new choice moves each header's buttons
 * down or up by the same amount at once, and nothing else in it. With the
 * step arrows it is their strip's height, whatever the design.
 */
export function useGrabberRoom(controls?: SheetControls | null): number {
  const room = grabberRoom(useSheetHandle());
  return useSheetArrows(controls) ? ARROW_STRIP : room;
}

/**
 * The grabber centered at the top of a phone's sheet that swipes
 * (docs/design/design-v1-sheet-swipe.md), as video apps draw over their comments:
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
export function SheetGrabber(props: { controls?: SheetControls | null; putAway?: string }) {
  const design = grabberDesign(useSheetHandle());
  const arrows = useSheetArrows(props.controls);
  const drawing = (
    <GrabberDrawing
      design={design}
      attrs={{ [GRABBER_ATTR]: "" }}
      style={{
        position: "absolute",
        top: arrows ? (ARROW_STRIP - design.height) / 2 : GRABBER_TOP,
        left: "50%",
        marginLeft: -design.width / 2,
        color: `color-mix(in srgb, var(${HELD_COLOR_VAR}, ${theme.color.controlBorder}) ${heldShare(`var(${PULL_VAR}, 0)`)}, ${theme.color.controlBorder})`,
        transform: `scale(calc(1 + var(${STRETCH_VAR}, 0) * ${STRETCH_X}), calc(1 - var(${STRETCH_VAR}, 0) * ${STRETCH_Y}))`,
        transformOrigin: "center",
        transition: `var(${GRABBER_TRANSITION_VAR}, color ${SLIDE_MS}ms ease, transform ${SLIDE_MS}ms cubic-bezier(0.34, 1.56, 0.64, 1))`,
        pointerEvents: "none",
      }}
    />
  );
  const controls = props.controls;
  if (!arrows || !controls) return drawing;
  const full = controls.stand === "full";
  const band = design.width + 2 * BAND_PAD;
  return (
    <>
      {controls.canFill ? <StepArrow side="up" label="Expand sheet" off={full} band={band} onPress={() => controls.step("full")} /> : null}
      {/* The drag band takes a mouse's or a pen's drag (lib/sheetSwipe.ts DRAG_BAND_ATTR). A finger swipes the whole grab area as before. */}
      <span {...{ [DRAG_BAND_ATTR]: "" }} style={{ position: "absolute", top: 0, left: "50%", marginLeft: -band / 2, width: band, height: ARROW_STRIP, cursor: "grab", userSelect: "none" }} />
      {drawing}
      <StepArrow side="down" label={full ? "Shrink sheet" : (props.putAway ?? "Put away sheet")} off={false} band={band} onPress={() => controls.step(full ? "normal" : "closed")} />
    </>
  );
}

/**
 * Up or Down beside the grabber: a 44 px target with a 32 x 24 px pill,
 * which takes the focus ring, so the ring stays whole at the screen's top
 * while the sheet fills it. Up at full is `aria-disabled`, never
 * `disabled`, so it keeps focus inside the full sheet's modal dialog.
 */
function StepArrow(props: { side: "up" | "down"; label: string; off: boolean; band: number; onPress(): void }) {
  const tooltip = useTooltip(props.label);
  const up = props.side === "up";
  return (
    <>
      <button
        type="button"
        aria-label={props.label}
        aria-disabled={props.off || undefined}
        data-sheet-step={props.side}
        {...PILL_FOCUS}
        {...tooltip.anchor()}
        onClick={() => {
          if (!props.off) props.onPress();
        }}
        style={{
          position: "absolute",
          top: 0,
          left: "50%",
          marginLeft: up ? -props.band / 2 - ARROW_STRIP : props.band / 2,
          width: ARROW_STRIP,
          height: ARROW_STRIP,
          display: "grid",
          placeItems: "center",
          padding: 0,
          border: "none",
          background: "transparent",
          color: props.off ? theme.color.textDisabled : theme.color.textMuted,
          cursor: props.off ? "default" : "pointer",
        }}
      >
        <span data-pill="" style={{ display: "grid", placeItems: "center", boxSizing: "border-box", width: ARROW_PILL.width, height: ARROW_PILL.height, borderRadius: theme.radius.sm, border: `${theme.line.border}px solid transparent` }}>
          <Icon name={up ? "chevronUp" : "chevronDown"} size="sm" />
        </span>
      </button>
      {tooltip.tip}
    </>
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
