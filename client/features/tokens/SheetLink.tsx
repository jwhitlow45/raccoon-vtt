import { Icon } from "../../components/Icon.tsx";
import { useTooltip } from "../../components/Tooltip.tsx";
import { theme } from "../../lib/theme.ts";

const NAME = "Open the sheet";
/**
 * What a 44 px target needs above and below one line of the line's own text,
 * in `lh` units so it follows whatever line height the stat line draws in.
 */
const REACH = `calc((${theme.touch}px - 1lh) / 2)`;

/**
 * The owner's D&D Beyond sheet as one compact unit of a stat line: "Sheet"
 * and the new tab's icon, named "Open the sheet" for a screen reader and in
 * the shared tooltip. It opens a new tab with no referrer and no opener.
 *
 * The unit is the line's own text height, so it never makes its line taller
 * than its neighbours. Its padding reaches the touch target's 44 px and an
 * equal negative margin takes the padding back out of the layout, the same
 * way the measure pill's button does (measure/controls.tsx LINE_BUTTON).
 * Padding goes above and below only, since neighbours stand close at the
 * sides.
 */
export function SheetLink(props: { url: string }) {
  const tooltip = useTooltip(NAME);
  return (
    <>
      <a
        href={props.url}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        aria-label={NAME}
        {...tooltip.anchor()}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: theme.space(1),
          boxSizing: "border-box",
          padding: `${REACH} 0`,
          margin: `calc(-1 * ${REACH}) 0`,
          color: theme.color.accent,
          fontWeight: theme.weight.strong,
          whiteSpace: "nowrap",
        }}
      >
        Sheet
        <Icon name="external" size="sm" />
      </a>
      {tooltip.tip}
    </>
  );
}
