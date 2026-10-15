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
 */
export function Chip(props: {
  ref?: Ref<HTMLButtonElement>;
  children: ReactNode;
  count?: number | null;
  pressed?: boolean;
  remove?: boolean;
  disabled?: boolean;
  title?: string;
  "aria-label"?: string;
  /** Marks for the caller's own queries, such as finding the chip to focus after one is removed. */
  [data: `data-${string}`]: string | boolean | undefined;
  onClick(): void;
}) {
  const remove = props.remove === true;
  const on = remove || props.pressed === true;
  const data = Object.fromEntries(Object.entries(props).filter(([key]) => key.startsWith("data-")));
  return (
    <button
      {...data}
      ref={props.ref}
      type="button"
      aria-pressed={remove ? undefined : props.pressed}
      aria-label={props["aria-label"]}
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: theme.space(1.5),
        flex: "none",
        minHeight: theme.touch,
        minWidth: theme.touch,
        // The close icon carries its own space at the right.
        padding: remove ? `0 ${theme.space(2)}px 0 ${theme.space(3)}px` : `0 ${theme.space(3)}px`,
        borderRadius: theme.radius.pill,
        fontSize: theme.font.body14,
        fontWeight: theme.weight.strong,
        fontFamily: theme.font.body,
        whiteSpace: "nowrap",
        cursor: props.disabled ? "default" : "pointer",
        ...choiceLook(on, props.disabled),
      }}
    >
      {props.children}
      {props.count !== undefined && props.count !== null ? (
        <span style={{ color: props.disabled ? theme.color.textDisabled : theme.color.textMuted, fontWeight: theme.weight.regular }}>{props.count}</span>
      ) : null}
      {remove ? <Icon name="close" size="sm" style={{ color: props.disabled ? theme.color.textDisabled : theme.color.textMuted }} /> : null}
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
