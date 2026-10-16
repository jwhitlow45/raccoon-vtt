import { useId, type CSSProperties, type ReactNode } from "react";
import { accessibleName } from "../lib/a11y.ts";
import { theme } from "../lib/theme.ts";
import { choiceLook } from "./looks.ts";

export type SegmentedOption<T extends string | number> = {
  value: T;
  label: ReactNode;
  /** The tooltip, and the name when the label has no words of its own (a glyph or a number, lib/a11y.ts). */
  title?: string;
  disabled?: boolean;
  /**
   * Drawn over the pressed look while this option is chosen and enabled,
   * for a choice whose color carries meaning, such as the HP entry's red
   * Damage and green Heal (docs/design-v1-visual.md 2.3). A disabled
   * option keeps the disabled look, so "cannot change now" reads the same
   * in every group.
   */
  chosenStyle?: CSSProperties;
};

/**
 * One choice of two to six (docs/design-v1-visual.md 2.3): the new scene
 * kind, light, who can read a page, the interface size, the tool modes.
 *
 * Each option is a native `<input type="radio">` lying unseen over its
 * whole option, inside the option's `<label>`, and every input in the
 * group shares one name. Why native radios rather than buttons with a
 * roving tabindex: the browser gives the group one Tab stop, arrow keys
 * that move and choose, and the right announcements, with no key handling
 * to write or test. The input covers its option, so a tap anywhere on it
 * hits the radio and the 44 px target holds, and the focus ring goes on
 * the option through the `.rvtt-choice` rule in globals.css.
 *
 * The group is a `radiogroup` named by `label` (or by the element
 * `labelledBy` names, such as a SettingRow's name), so
 * `getByRole("radiogroup", { name })` and `getByRole("radio", { name })`
 * keep finding it. A tap on the chosen option does nothing, as with any
 * radio.
 */
export function Segmented<T extends string | number>(props: {
  label?: string;
  labelledBy?: string;
  value: T | null;
  options: readonly SegmentedOption<T>[];
  // NoInfer: T comes from the options, so a state setter passed here does not widen it.
  onChange(value: NoInfer<T>): void;
  disabled?: boolean;
  /** Options share the row's width, for a choice that spans a panel. */
  grow?: boolean;
  /**
   * Options split the row's width equally and stay on one line, for a short
   * choice in a narrow place such as the token action bar. `grow` lets each
   * option keep its own width and wrap, which there would break the row
   * into uneven pieces. The side padding shrinks so four labels still fit,
   * and under 210 px, too narrow even so, they go two by two.
   */
  even?: boolean;
  style?: CSSProperties;
}) {
  const name = useId();
  const group = (
    <div
      role="radiogroup"
      aria-label={props.labelledBy ? undefined : props.label}
      aria-labelledby={props.labelledBy}
      aria-disabled={props.disabled ? true : undefined}
      className={props.even ? "rvtt-even-choices" : undefined}
      style={{ display: "flex", flexWrap: props.even ? "nowrap" : "wrap", gap: theme.space(1), minWidth: 0, ...(props.even ? null : props.style) }}
    >
      {props.options.map((o) => {
        const chosen = o.value === props.value;
        const disabled = props.disabled === true || o.disabled === true;
        return (
          <label
            key={String(o.value)}
            className="rvtt-choice"
            title={o.title}
            style={{
              position: "relative",
              flex: props.even ? "1 1 0" : props.grow ? "1 0 auto" : "none",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: theme.touch,
              minWidth: theme.touch,
              padding: `0 ${theme.space(props.even ? 1 : 3)}px`,
              borderRadius: theme.radius.md,
              fontSize: theme.font.body14,
              fontWeight: theme.weight.strong,
              whiteSpace: "nowrap",
              cursor: disabled ? "default" : "pointer",
              ...choiceLook(chosen, disabled),
              ...(chosen && !disabled ? o.chosenStyle : undefined),
            }}
          >
            <input
              type="radio"
              name={name}
              value={String(o.value)}
              checked={chosen}
              disabled={disabled}
              aria-label={accessibleName(o.label, o.title)}
              onChange={() => props.onChange(o.value)}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", margin: 0, opacity: 0, cursor: "inherit" }}
            />
            {o.label}
          </label>
        );
      })}
    </div>
  );
  // Even options measure the room they share, so where four cannot fit side by side they go two by two (globals.css).
  return props.even ? <div style={{ containerType: "inline-size", minWidth: 0, ...props.style }}>{group}</div> : group;
}
