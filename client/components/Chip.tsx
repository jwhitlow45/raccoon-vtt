import type { ReactNode, Ref } from "react";
import { theme } from "../lib/theme.ts";
import { Icon } from "./Icon.tsx";
import { choiceLook } from "./looks.ts";

/**
 * A filter or a quick pick (docs/design-v1-visual.md 2.3): the outliner's
 * filters, the monster filters, DC chips, range ring presets. A pill 44 px
 * tall at 14 px weight 600, with an optional count in muted text, and the
 * pressed look when on (`aria-pressed`). A row of them wraps with
 * `space(1)` between, as ChipRow lays them out.
 *
 * `remove` is a filter that is on, shown apart from the filters, whose tap
 * takes it off (the monster filters under the search): the chosen look
 * and a close icon, and no `aria-pressed`, since the tap removes it rather
 * than toggling it. Its `aria-label` says so ("Remove the filter Large").
 *
 * `circle` makes a 44 px circle of a short value, such as a range ring's
 * distance, so a row of them reads as one set whatever their digits. Four
 * digits still fit inside it.
 *
 * `unavailable` is off for now but stays in the tab order: the disabled
 * look, `aria-disabled` and a tap that does nothing, with `describedBy`
 * naming the line that says why, such as the range rings' limit. A truly
 * disabled chip would leave the keyboard and a screen reader no way to
 * find it or the reason.
 */
export function Chip(props: {
  ref?: Ref<HTMLButtonElement>;
  children: ReactNode;
  count?: number | null;
  pressed?: boolean;
  remove?: boolean;
  circle?: boolean;
  disabled?: boolean;
  unavailable?: boolean;
  describedBy?: string;
  title?: string;
  "aria-label"?: string;
  /** Words that may be long, such as a monster's rider: they wrap inside the chip, which grows a line, rather than run past its row's edge. */
  wrap?: boolean;
  /** Marks for the caller's own queries, such as finding the chip to focus after one is removed. */
  [data: `data-${string}`]: string | boolean | undefined;
  onClick(): void;
}) {
  const remove = props.remove === true;
  const circle = props.circle === true;
  const on = remove || props.pressed === true;
  const off = props.disabled === true || props.unavailable === true;
  const data = Object.fromEntries(Object.entries(props).filter(([key]) => key.startsWith("data-")));
  return (
    <button
      {...data}
      ref={props.ref}
      type="button"
      aria-pressed={remove ? undefined : props.pressed}
      aria-label={props["aria-label"]}
      aria-disabled={props.unavailable && !props.disabled ? true : undefined}
      aria-describedby={props.describedBy}
      title={props.title}
      disabled={props.disabled}
      onClick={() => {
        if (!off) props.onClick();
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        // A value narrower than the 44 px minimum stays in the middle rather than against the left padding.
        justifyContent: "center",
        gap: theme.space(1.5),
        ...(props.wrap ? { flex: "0 1 auto", maxWidth: "100%", textAlign: "center" as const } : { flex: "none" }),
        minHeight: theme.touch,
        minWidth: theme.touch,
        ...(circle ? { width: theme.touch, height: theme.touch } : null),
        // The close icon carries its own space at the right.
        padding: circle ? 0 : remove ? `0 ${theme.space(2)}px 0 ${theme.space(3)}px` : `0 ${theme.space(3)}px`,
        borderRadius: theme.radius.pill,
        fontSize: theme.font.body14,
        fontWeight: theme.weight.strong,
        fontFamily: theme.font.body,
        whiteSpace: props.wrap ? "normal" : "nowrap",
        cursor: off ? "default" : "pointer",
        ...choiceLook(on, off),
      }}
    >
      {props.children}
      {props.count !== undefined && props.count !== null ? (
        <span style={{ color: off ? theme.color.textDisabled : theme.color.textMuted, fontWeight: theme.weight.regular, fontVariantNumeric: "tabular-nums" }}>{props.count}</span>
      ) : null}
      {remove ? <Icon name="close" size="sm" style={{ color: off ? theme.color.textDisabled : theme.color.textMuted }} /> : null}
    </button>
  );
}

/** Chips in a wrapping row. */
export function ChipRow(props: { label?: string; children: ReactNode }) {
  return (
    <div role={props.label ? "group" : undefined} aria-label={props.label} style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
      {props.children}
    </div>
  );
}
