import { Children, isValidElement, useId, type CSSProperties, type ReactNode, type Ref } from "react";
import { theme } from "../lib/theme.ts";
import { Icon } from "./Icon.tsx";

/**
 * One line of a list (docs/design-v1-visual.md 2.3): members, scenes,
 * rooms, characters, the outliner. At least 44 px, or 56 px with a detail
 * line. A leading slot (a 32 px disk or a 20 px dot), the title at 16 px
 * weight 600 cut with an ellipsis, a detail line at 13 px muted, and a
 * trailing slot for a value, a tag, a small button or the more button.
 *
 * `onClick` makes the whole row one button, which then looks like a card:
 * raised, rounded, outlined (Menu items, the Claim page's "This is me",
 * character cards). Its trailing slot must then hold no control of its
 * own, since a button inside a button is not allowed. `chosen` (the scene
 * you are on) takes the accent tint and outline. `turn` marks the
 * creature whose turn it is, in the fixed cream highlight, never the
 * accent. `pressed` makes the row a toggle button, such as a known form
 * chosen (docs/design-v1-known-forms.md 5.2): `chosen`'s look without its
 * `aria-current`, and a check in the leading slot, which an unpressed one
 * keeps empty so the titles line up.
 *
 * A row that unfolds a short body under itself keeps its own look, never
 * the chosen tint, and ends in `RowChevron` (docs/design-v1-look-pass-2.md
 * 2.5).
 */
export function Row(props: {
  ref?: Ref<HTMLButtonElement>;
  leading?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  chosen?: boolean;
  turn?: boolean;
  /** A toggle row's state, as `aria-pressed`. Only with `onClick`. */
  pressed?: boolean;
  /** Shows the card look without being a button, for a card whose actions sit in its trailing slot. */
  card?: boolean;
  disabled?: boolean;
  onClick?(): void;
  /** The button's name, when the row's visible text would read poorly as one. */
  label?: string;
  /** For a row that shows or hides what is under it, as a disclosure: its button's `aria-expanded`. */
  expanded?: boolean;
  /**
   * A detail that wraps onto as many lines as it needs, never cut, and that
   * describes the button rather than naming it, so a disclosure is named by
   * its title alone, as a re-sync's group of changes is with its summary
   * (docs/design-v1-resync.md 3.3).
   */
  fullDetail?: boolean;
  /**
   * A title that wraps onto as many lines as it needs, never cut, for a row
   * that names an action which must read whole, such as "Get on Treasure
   * chest" on a 320 px phone.
   */
  wrapTitle?: boolean;
  /** The work this row started is under way: `aria-busy` on its button. Only with `onClick`. */
  busy?: boolean;
  /** `data-*` attributes on its button, by which a list's own keys find its rows, such as the Attach list's `data-attach-row`. Only with `onClick`. */
  data?: Record<`data-${string}`, string>;
  /**
   * A stable id for a row that opens a panel's subpage, as `data-opener`,
   * so Back finds this row again even after the list mounts anew,
   * reorders, or holds another row of the same name
   * (features/panels.ts useSubpageFocus).
   */
  opener?: string;
  style?: CSSProperties;
}) {
  const card = props.card === true || props.onClick !== undefined;
  const titleId = useId();
  const detailId = useId();
  const full = props.fullDetail === true && props.detail !== undefined && props.detail !== null;
  const look: CSSProperties = props.chosen || props.pressed
    ? { background: theme.color.accentTint, border: `${theme.line.border}px solid ${theme.color.accent}` }
    : props.turn
      ? { background: theme.color.turnTint, border: `${theme.line.border}px solid ${theme.color.accentSoft}` }
      : card
        ? { background: theme.color.surfaceRaised, border: `${theme.line.border}px solid ${theme.color.border}` }
        : { background: "transparent", border: `${theme.line.border}px solid transparent` };
  const style: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: theme.space(3),
    width: "100%",
    minHeight: props.detail ? 56 : theme.touch,
    padding: `${theme.space(2)}px ${theme.space(3)}px`,
    borderRadius: card || props.chosen || props.pressed || props.turn ? theme.radius.md : 0,
    color: props.disabled ? theme.color.textDisabled : theme.color.text,
    fontFamily: theme.font.body,
    textAlign: "left",
    ...look,
    ...props.style,
  };
  const leading =
    props.pressed === undefined ? props.leading : (
      <span aria-hidden style={{ display: "grid", placeItems: "center", width: 20, height: 20, color: theme.color.accent }}>
        {props.pressed ? <Icon name="check" size="md" /> : null}
      </span>
    );
  const body = (
    <>
      {leading ? <span style={{ flex: "none", display: "grid", placeItems: "center" }}>{leading}</span> : null}
      <span style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(0.5) }}>
        <span
          id={full ? titleId : undefined}
          style={{
            fontSize: theme.font.input,
            fontWeight: theme.weight.strong,
            lineHeight: theme.leading.tight,
            ...(props.wrapTitle ? { overflowWrap: "anywhere" } : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }),
          }}
        >
          {props.title}
        </span>
        {props.detail ? (
          <span
            id={full ? detailId : undefined}
            style={{
              fontSize: theme.font.small,
              lineHeight: full ? theme.leading.body : theme.leading.tight,
              color: props.disabled ? theme.color.textDisabled : theme.color.textMuted,
              ...(full ? { overflowWrap: "anywhere" } : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }),
            }}
          >
            {props.detail}
          </span>
        ) : null}
      </span>
      {props.trailing ? <span style={{ flex: "none", display: "flex", alignItems: "center", gap: theme.space(2) }}>{props.trailing}</span> : null}
    </>
  );
  if (!props.onClick) {
    return (
      <div data-opener={props.opener} style={style}>
        {body}
      </div>
    );
  }
  return (
    <button
      ref={props.ref}
      type="button"
      {...props.data}
      data-opener={props.opener}
      aria-label={props.label}
      aria-labelledby={full && props.label === undefined ? titleId : undefined}
      aria-describedby={full ? detailId : undefined}
      aria-current={props.chosen ? true : undefined}
      aria-pressed={props.pressed}
      aria-expanded={props.expanded}
      aria-busy={props.busy ? true : undefined}
      disabled={props.disabled}
      onClick={(e) => {
        // A disclosure takes focus before it folds, so a field being typed in under it blurs and commits first, and focus stays on the row.
        if (props.expanded !== undefined) e.currentTarget.focus();
        props.onClick?.();
      }}
      style={{ ...style, cursor: props.disabled ? "default" : "pointer" }}
    >
      {body}
    </button>
  );
}

/**
 * Rows in a list, split by 1 px lines. A card row needs none: give card
 * rows a gap instead. Each item is keyed by its row's own key, so when the
 * list reorders or grows, a row moves with its item and keeps its focus
 * and state. Keyed by position, a moved row would mount afresh in another
 * item.
 */
export function RowList(props: { label?: string; children: ReactNode }) {
  const items = Children.toArray(props.children);
  return (
    <ul aria-label={props.label} style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {items.map((child, i) => (
        <li key={isValidElement(child) && child.key !== null ? child.key : i} style={{ borderTop: i === 0 ? undefined : `${theme.line.border}px solid ${theme.color.border}` }}>
          {child}
        </li>
      ))}
    </ul>
  );
}

/**
 * The end of a row that unfolds what is under it: one chevron, muted, at
 * `md`, pointing down while open and right while folded, so every such row
 * draws the same one (docs/design-v1-look-pass-2.md 2.5). Decoration only:
 * the row's `aria-expanded` says the state.
 */
export function RowChevron(props: { open: boolean }) {
  return <Icon name={props.open ? "chevronDown" : "chevronRight"} size="md" style={{ color: theme.color.textMuted }} />;
}

/** A row's leading dot, in a member's or a disposition's color. */
export function RowDot(props: { color: string; size?: number }) {
  const size = props.size ?? 20;
  return <span aria-hidden style={{ display: "block", width: size, height: size, borderRadius: theme.radius.round, background: props.color }} />;
}

/**
 * A member's color dot before their name, as a checkbox's label (Owners,
 * Played by, a handout's players, a group's Owners). A block, not an inline box: on a line, an inline flex box
 * sits by its first item's baseline, which for the dot is its bottom edge,
 * and that left the name 1.5 px high in its row at 130% (LP22-ALIGN-2).
 */
export function DotLabel(props: { color: string; children: ReactNode }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
      <RowDot color={props.color} size={12} />
      {props.children}
    </span>
  );
}

/** A row's 32 px leading disk: a picture, or initials on a color. */
export function RowDisk(props: { color?: string; image?: string; children?: ReactNode }) {
  return (
    <span
      aria-hidden
      style={{
        display: "grid",
        placeItems: "center",
        width: 32,
        height: 32,
        borderRadius: theme.radius.round,
        overflow: "hidden",
        background: props.color ?? theme.color.surfaceRaised,
        color: theme.color.white,
        fontSize: theme.font.small,
        fontWeight: theme.weight.bold,
      }}
    >
      {props.image ? <img src={props.image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /> : props.children}
    </span>
  );
}
