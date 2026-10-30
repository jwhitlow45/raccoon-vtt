import { useId, type CSSProperties, type ReactNode } from "react";
import { theme } from "../lib/theme.ts";
import { Help } from "./Panel.tsx";

export type RadioCardOption<V extends string> = { value: V; label: string; help?: ReactNode };

/** The radio's circle, larger than the browser's own so a card's mark reads at a glance. */
const RADIO = 20;

const NAME: CSSProperties = { padding: 0, fontSize: theme.font.input, fontWeight: theme.weight.strong, lineHeight: theme.leading.tight };

/**
 * One choice of a few, each option a full-width card with its own
 * explanation (docs/design-v1-visual.md 2.3): Room settings' choices, This
 * device's Map images, a handout's Show to and Players see. The chosen card
 * takes the accent's outline and tint. A disabled group keeps its shape
 * with a quiet outline and dim text, never a fade. A choice of a few short
 * words with no help of their own is a `Segmented` instead
 * (docs/design-v1-design-pass.md 2.4 rule 4).
 *
 * The cards stand in one block under the name and its help: their fills
 * start at the name's edge and their words sit in by a card's border and
 * padding, the control's own inset. As rows of one column beside the name,
 * the alignment sweep read that inset as words off the column's edge on
 * every choice.
 *
 * Each radio is named by its card's label alone and described by its help,
 * so "Explore" finds it. The group is described by its help, then by the
 * chosen card's help, or by `none` while nothing is chosen (a scene's
 * Custom). It is a fieldset under a legend, a named group, unless
 * `radiogroup` asks for a radio group under a name, the role Players see
 * has always had and its checks find it by.
 *
 * `busy`, a change on its way: a tap does nothing, and the controlled
 * `checked` puts the radios back as they were. `status` is the work in
 * hand, said in a polite line under the cards that stays mounted while
 * empty so a screen reader hears it as it comes, together with `none`.
 * Only what the line says takes room.
 *
 * `data-card-group` marks the cards' column for the spacing check
 * (e2e/helpers/spacing.ts), which holds the name over its first card.
 */
export function RadioCards<V extends string>(props: {
  legend: string;
  help?: ReactNode;
  value: V | null;
  options: readonly RadioCardOption<V>[];
  radiogroup?: boolean;
  disabled?: boolean;
  busy?: boolean;
  status?: ReactNode;
  /** The words that describe the group while no option is chosen, in the warning tone in the status line. */
  none?: ReactNode;
  onChange(value: V): void;
}) {
  const name = useId();
  const nameId = useId();
  const helpId = useId();
  const noneId = useId();
  const optionId = useId();
  const { disabled } = props;
  const chosen = props.options.findIndex((o) => o.value === props.value);
  const chosenHelp = chosen >= 0 && props.options[chosen]?.help ? `${optionId}-help-${chosen}` : null;
  const describedBy = [props.help ? helpId : null, chosen >= 0 ? chosenHelp : props.none ? noneId : null].filter(Boolean).join(" ") || undefined;
  const nameStyle: CSSProperties = { ...NAME, color: disabled ? theme.color.textDisabled : theme.color.text };
  const lined = props.status !== undefined || props.none !== undefined;
  const status = lined ? (
    <div role="status" style={{ display: "grid", minWidth: 0, ...(props.status || (chosen < 0 && props.none) ? { marginTop: theme.space(1) } : null) }}>
      {props.status}
      <span id={noneId} style={chosen >= 0 || !props.none ? { display: "none" } : { fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.warning, overflowWrap: "anywhere" }}>
        {chosen >= 0 ? null : props.none}
      </span>
    </div>
  ) : null;

  const cards = props.options.map((o, i) => {
    const on = i === chosen;
    const look: CSSProperties = disabled
      ? { border: `${theme.line.border}px solid ${theme.color.border}`, background: "transparent", color: theme.color.textDisabled }
      : on
        ? { border: `${theme.line.border}px solid ${theme.color.accent}`, background: theme.color.accentTint, color: theme.color.text }
        : { border: `${theme.line.border}px solid ${theme.color.border}`, background: "transparent", color: theme.color.text };
    return (
      <label
        key={o.value}
        style={{
          display: "flex",
          alignItems: "center",
          gap: theme.space(3),
          minHeight: theme.touch,
          minWidth: 0,
          padding: `${theme.space(1)}px ${theme.space(2)}px`,
          borderRadius: theme.radius.md,
          cursor: disabled ? "default" : "pointer",
          ...look,
        }}
      >
        <input
          type="radio"
          name={name}
          value={o.value}
          checked={on}
          disabled={disabled}
          aria-labelledby={`${optionId}-name-${i}`}
          aria-describedby={o.help ? `${optionId}-help-${i}` : undefined}
          onChange={() => {
            if (!props.busy) props.onChange(o.value);
          }}
          style={{ width: RADIO, height: RADIO, margin: 0, flex: "none", accentColor: theme.color.accent }}
        />
        <span style={{ display: "grid", gap: theme.space(0.5), minWidth: 0 }}>
          <span id={`${optionId}-name-${i}`} style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong, overflowWrap: "anywhere" }}>
            {o.label}
          </span>
          {o.help ? (
            <span
              id={`${optionId}-help-${i}`}
              style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, color: disabled ? theme.color.textDisabled : theme.color.textMuted, overflowWrap: "anywhere" }}
            >
              {o.help}
            </span>
          ) : null}
        </span>
      </label>
    );
  });

  /*
   * Both forms stand one column under the name: the help `space(1)` under
   * it, and the cards `space(2)` under whatever stands above them, further
   * than the cards stand from each other, so the first card never reads as
   * part of the name (docs/design-v1-spacing-pass.md S1). Margins, not a
   * gap: a fieldset's gap never reaches its rendered legend, which is no
   * grid item, and left the cards on it.
   */
  const help = props.help ? (
    <Help id={helpId} style={{ marginTop: theme.space(1) }}>
      {props.help}
    </Help>
  ) : null;
  const column: CSSProperties = { display: "grid", gap: theme.space(1), marginTop: theme.space(2), minWidth: 0 };

  if (props.radiogroup) {
    return (
      // No gap of its own: the status under the cards is mounted while empty, and only what it says takes room.
      <div style={{ display: "grid", minWidth: 0 }}>
        <span id={nameId} style={nameStyle}>
          {props.legend}
        </span>
        {help}
        <div
          role="radiogroup"
          aria-labelledby={nameId}
          aria-describedby={describedBy}
          aria-busy={props.busy ? true : undefined}
          aria-disabled={disabled ? true : undefined}
          data-card-group=""
          style={column}
        >
          {cards}
        </div>
        {status}
      </div>
    );
  }
  const group = (
    <fieldset
      aria-describedby={describedBy}
      aria-busy={props.busy ? true : undefined}
      disabled={disabled}
      style={{ margin: 0, padding: 0, border: "none", minWidth: 0 }}
    >
      <legend style={nameStyle}>{props.legend}</legend>
      <div style={{ display: "grid", minWidth: 0 }}>
        {help}
        <div data-card-group="" style={column}>
          {cards}
        </div>
      </div>
    </fieldset>
  );
  return status ? (
    <div style={{ display: "grid", minWidth: 0 }}>
      {group}
      {status}
    </div>
  ) : (
    group
  );
}
