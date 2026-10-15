import { useId, type CSSProperties } from "react";
import { contrast } from "../lib/accent.ts";
import { MEMBER_COLOR_NAMES, theme } from "../lib/theme.ts";

export type SwatchOption = {
  color: string;
  /** The accessible name. The member palette's names by default ("Green"), so no one hears a hex code. */
  name?: string;
  /** A few letters on the swatch's lower right: who uses the color, as an initial or "DM". */
  badge?: string;
};

/** A color's name from the member palette, or null for a color outside it. */
export function memberColorName(color: string): string | null {
  return (MEMBER_COLOR_NAMES as Record<string, string | undefined>)[color.toLowerCase()] ?? null;
}

/** Text that reads on a color: dark ink on a light swatch, white on a dark one. */
export function inkOn(color: string): string {
  return contrast(theme.color.ink, color) >= contrast(theme.color.white, color) ? theme.color.ink : theme.color.white;
}

/**
 * One row of colors to pick from (docs/design-v1-visual.md 2.3): draw,
 * pins, areas, the icon disk and members. 44 px options with 28 px disks,
 * the chosen one ringed in text color with a gap of the page color, so the
 * ring reads around any color, white included.
 *
 * Each option is a native radio over its whole option, as in Segmented:
 * one Tab stop for the row, arrow keys that move and choose, and the focus
 * ring on the option (`.rvtt-choice` in globals.css).
 *
 * A badge marks a color someone uses (section 4). It never fades the disk:
 * a faded yellow turned olive and looked disabled, though it could be
 * picked. Disabled keeps each disk's color, since the color is the
 * content, and dims the ring and the badge. The caller's legend says why.
 */
export function Swatches(props: {
  label?: string;
  labelledBy?: string;
  value: string | null;
  options: readonly (string | SwatchOption)[];
  onChange(color: string): void;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  const name = useId();
  const value = props.value?.toLowerCase() ?? null;
  const disabled = props.disabled === true;
  return (
    <div
      role="radiogroup"
      aria-label={props.labelledBy ? undefined : props.label}
      aria-labelledby={props.labelledBy}
      aria-disabled={disabled ? true : undefined}
      style={{ display: "flex", flexWrap: "wrap", gap: theme.space(0.5), minWidth: 0, ...props.style }}
    >
      {props.options.map((raw) => {
        const option: SwatchOption = typeof raw === "string" ? { color: raw } : raw;
        const chosen = option.color.toLowerCase() === value;
        const ring = disabled ? theme.color.textDisabled : theme.color.text;
        return (
          <label
            key={option.color}
            className="rvtt-choice"
            style={{
              position: "relative",
              display: "grid",
              placeItems: "center",
              width: theme.touch,
              height: theme.touch,
              borderRadius: theme.radius.md,
              cursor: disabled ? "default" : "pointer",
            }}
          >
            <input
              type="radio"
              name={name}
              value={option.color}
              checked={chosen}
              disabled={disabled}
              aria-label={option.name ?? memberColorName(option.color) ?? option.color}
              onChange={() => props.onChange(option.color)}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", margin: 0, opacity: 0, cursor: "inherit" }}
            />
            {/* Drawn after the radio, so it paints on top: it lets every pointer through, so a tap or a click on the disk reaches the radio itself. */}
            <span
              aria-hidden
              style={{
                position: "relative",
                display: "block",
                pointerEvents: "none",
                padding: theme.line.strong,
                borderRadius: theme.radius.round,
                border: `${theme.line.strong}px solid ${chosen ? ring : "transparent"}`,
                background: chosen ? theme.color.bg : "transparent",
              }}
            >
              <span style={{ display: "block", width: 28, height: 28, borderRadius: theme.radius.round, background: option.color, boxSizing: "border-box", border: `${theme.line.border}px solid ${theme.color.border}` }} />
              {option.badge ? (
                <span
                  style={{
                    position: "absolute",
                    right: -theme.space(0.5),
                    bottom: -theme.space(0.5),
                    display: "grid",
                    placeItems: "center",
                    minWidth: 16,
                    height: 16,
                    padding: `0 ${theme.space(0.5)}px`,
                    borderRadius: theme.radius.pill,
                    background: option.color,
                    border: `${theme.line.border}px solid ${disabled ? theme.color.textDisabled : theme.color.bg}`,
                    color: disabled ? theme.color.textDisabled : inkOn(option.color),
                    fontSize: theme.font.tiny,
                    fontWeight: theme.weight.bold,
                    lineHeight: 1,
                  }}
                >
                  {option.badge}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}
