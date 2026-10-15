import { useId, useLayoutEffect, useRef, type ReactNode, type Ref } from "react";
import { theme } from "../lib/theme.ts";

/**
 * A native checkbox at 22 px in a full-width row, so the whole line is the
 * 44 px target (docs/design-v1-visual.md 2.3 and 3.7). For picking several
 * items in a list, a filter, and options of a form that a button then
 * submits: placing monsters, a journal page's secret block, a pin's DM
 * only, a roll request's "Players see" options. A setting that takes
 * effect at once is a Switch instead.
 *
 * The box takes the accent through `accentColor`, and `color-scheme: dark`
 * (globals.css) draws an unchecked one dark, where it used to be a white
 * square. `indeterminate` shows a mixed state, such as a setting that
 * differs across the selected tokens.
 */
export function Checkbox(props: {
  ref?: Ref<HTMLInputElement>;
  label: ReactNode;
  help?: ReactNode;
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
  name?: string;
  value?: string;
}) {
  const id = useId();
  const labelId = useId();
  const helpId = useId();
  const box = useRef<HTMLInputElement | null>(null);
  const indeterminate = props.indeterminate === true;
  const latest = useRef(indeterminate);
  latest.current = indeterminate;
  /*
   * The mixed state has no attribute, only a property of the element, and a
   * click clears it. So it is set again after every render, whatever
   * changed, and once more after a change, for a caller that keeps the
   * state mixed and so does not render again (a refused op).
   */
  useLayoutEffect(() => {
    if (box.current) box.current.indeterminate = latest.current;
  });
  const setRef = (el: HTMLInputElement | null) => {
    box.current = el;
    const outer = props.ref;
    if (typeof outer === "function") outer(el);
    else if (outer) outer.current = el;
  };
  return (
    <label
      htmlFor={id}
      style={{
        display: "flex",
        alignItems: props.help ? "flex-start" : "center",
        gap: theme.space(3),
        minHeight: theme.touch,
        padding: `${theme.space(1)}px 0`,
        color: props.disabled ? theme.color.textDisabled : theme.color.text,
        cursor: props.disabled ? "default" : "pointer",
      }}
    >
      <input
        ref={setRef}
        id={id}
        type="checkbox"
        name={props.name}
        value={props.value}
        checked={props.checked}
        disabled={props.disabled}
        // Named by the label alone, with the help as its description, though the whole row is the label that takes the tap.
        aria-labelledby={props.help ? labelId : undefined}
        aria-describedby={props.help ? helpId : undefined}
        onChange={(e) => {
          const el = e.currentTarget;
          props.onChange(el.checked);
          queueMicrotask(() => {
            el.indeterminate = latest.current;
          });
        }}
        style={{ width: 22, height: 22, margin: props.help ? `${theme.space(0.5)}px 0 0` : 0, flex: "none", accentColor: theme.color.accent }}
      />
      <span style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(0.5) }}>
        <span id={labelId} style={{ fontSize: theme.font.body14, lineHeight: theme.leading.body }}>
          {props.label}
        </span>
        {props.help ? (
          <span id={helpId} style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, color: props.disabled ? theme.color.textDisabled : theme.color.textMuted }}>
            {props.help}
          </span>
        ) : null}
      </span>
    </label>
  );
}
