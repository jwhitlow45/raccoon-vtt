import { useEffect, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode, type Ref } from "react";
import { Button } from "../../components/Button.tsx";
import type { IconName } from "../../components/Icon.tsx";
import { buttonLook } from "../../components/looks.ts";
import { FieldRow as PanelFieldRow, fieldStyle, NUMBER_FIELD_WIDTH, Select as FieldSelect, useRowHint } from "../../components/Field.tsx";
import { Help, Section as PanelSection } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";

/**
 * Small controls the token, character and monster panels share. Every
 * target is at least 44 px and every input uses a 16 px font, so iOS does
 * not zoom the page on focus (design section 14.4).
 *
 * Text and number fields keep a local draft and send their op once, on
 * blur or Enter, never per keystroke: one edit is one op, one undo step,
 * and one line in everyone's event stream.
 *
 * Most of these are now thin wrappers over the shared components
 * (docs/design-v1-visual.md 2.3), kept with their old props so the many
 * panels that import them look the same as every other panel without each
 * changing at once.
 */

export const inputStyle: CSSProperties = fieldStyle();

/** A token panel section. `title` is left out where its group's heading already names it, as Notes and Position. */
export function Section(props: { title?: string; children: ReactNode; aside?: ReactNode; fold?: ComponentProps<typeof PanelSection>["fold"] }) {
  return (
    <PanelSection label={props.title} action={props.aside} fold={props.fold}>
      {props.children}
    </PanelSection>
  );
}

/** A label on the left and its control on the right, wrapping on narrow sheets. `fill` for a control that stretches (components/Field.tsx). */
export function FieldRow(props: { label: string; children: ReactNode; htmlFor?: string; hint?: ReactNode; fill?: boolean }) {
  return (
    <PanelFieldRow label={props.label} htmlFor={props.htmlFor} hint={props.hint} fill={props.fill}>
      {props.children}
    </PanelFieldRow>
  );
}

type DraftFocus = {
  onFocus(): void;
  /** Ends the edit. False when Escape asked to throw the draft away, so the field must not commit it. */
  onBlur(): boolean;
  /** Escape: puts the outside value back and leaves the field without saving. */
  discard(input: HTMLElement): void;
};

/**
 * A draft that follows the outside value whenever the field is not being
 * edited. `leave` is the field's commit, which it sets on every render: a
 * field taken away while it is still being edited, by a fold, a card that
 * closes or a panel that remounts, commits what was typed then, since no
 * blur comes from an element that is gone.
 */
function useDraft<T>(value: T): [T, (v: T) => void, DraftFocus, { current: () => void }] {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  // blur() runs the blur handler at once, from the render that still holds
  // the edited draft, before the reset below can render. So Escape leaves
  // this mark for that handler instead of relying on the reset.
  const discarding = useRef(false);
  const leave = useRef<() => void>(() => {});
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  useEffect(
    () => () => {
      if (editing.current && !discarding.current) leave.current();
    },
    [],
  );
  return [
    draft,
    setDraft,
    {
      onFocus: () => {
        editing.current = true;
        discarding.current = false;
      },
      onBlur: () => {
        editing.current = false;
        const keep = !discarding.current;
        discarding.current = false;
        return keep;
      },
      discard: (input) => {
        discarding.current = true;
        setDraft(value);
        input.blur();
      },
    },
    leave,
  ];
}

export function TextField(props: {
  value: string;
  onCommit(value: string): void;
  label: string;
  id?: string;
  placeholder?: string;
  maxLength?: number;
  multiline?: boolean;
  /** A multiline field's starting height in rows. It still resizes. */
  rows?: number;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  const [draft, setDraft, focus, leave] = useDraft(props.value);
  const commit = () => {
    if (draft !== props.value) props.onCommit(draft);
  };
  leave.current = commit;
  const describedBy = useRowHint();
  const common = {
    id: props.id,
    "aria-label": props.label,
    "aria-describedby": describedBy,
    value: draft,
    placeholder: props.placeholder,
    maxLength: props.maxLength,
    disabled: props.disabled,
    onFocus: focus.onFocus,
    onBlur: () => {
      if (focus.onBlur()) commit();
    },
  };
  if (props.multiline) {
    return (
      <textarea
        {...common}
        rows={props.rows ?? 3}
        onChange={(e) => setDraft(e.target.value)}
        style={{ ...fieldStyle({ disabled: props.disabled }), width: "100%", padding: theme.space(3), resize: "vertical", lineHeight: theme.leading.body, ...props.style }}
      />
    );
  }
  return (
    <input
      {...common}
      type="text"
      enterKeyHint="done"
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") focus.discard(e.currentTarget);
      }}
      style={{ ...fieldStyle({ disabled: props.disabled }), flex: 1, width: "100%", ...props.style }}
    />
  );
}

type NumberFieldProps = {
  value: number | undefined;
  onCommit(value: number | null): void;
  label: string;
  id?: string;
  min: number;
  max: number;
  nullable?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Off for now but still in the tab order, as Chip's `unavailable` is:
   * read only, `aria-disabled` and the disabled look, with `describedBy`
   * naming the line that says why.
   */
  unavailable?: boolean;
  describedBy?: string;
  /** Pixels, or a length such as "100%" for a field that fills a box its caller sizes. */
  width?: number | string;
  /**
   * What a commit would send as the field now stands, told whenever that
   * changes: a number, null to unset, or undefined for nothing. For a form
   * that sends only from its own button, whose Back must know of a number
   * typed and not yet committed, since the field commits on blur and a
   * press can leave focus where it is (characterPage.ts usePendingNumbers).
   */
  onPending?(value: number | null | undefined): void;
};

/**
 * What committing a number field's `draft` does: the text it then `shows`,
 * and what it `sends`, absent when it sends nothing. Empty unsets a
 * `nullable` field that has a value, and otherwise snaps back, as text that
 * is no number does. A number is rounded and clamped to the bounds.
 */
export function numberCommit(draft: string, field: Pick<NumberFieldProps, "value" | "min" | "max" | "nullable">): { shows: string; sends?: number | null } {
  const text = field.value === undefined ? "" : String(field.value);
  const trimmed = draft.trim().replace(/[\u2212\u2013]/g, "-");
  if (trimmed === "") return field.nullable && field.value !== undefined ? { shows: "", sends: null } : { shows: text };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { shows: text };
  const clamped = Math.min(field.max, Math.max(field.min, Math.round(n)));
  return clamped === field.value ? { shows: String(clamped) } : { shows: String(clamped), sends: clamped };
}

/**
 * A whole number within bounds. Empty means "unset" when `nullable`, and
 * otherwise snaps back to the current value. Right aligned, so digits line
 * up down a panel (components/Field.tsx).
 */
export function NumberField(props: NumberFieldProps) {
  return <DraftNumber {...props} align="right" />;
}

/** The number field itself. A Stepper centers its value between the buttons that change it. */
function DraftNumber(props: NumberFieldProps & { align: "right" | "center" }) {
  const text = props.value === undefined ? "" : String(props.value);
  const [draft, setDraft, focus, leave] = useDraft(text);
  const result = numberCommit(draft, props);
  const commit = () => {
    setDraft(result.shows);
    if ("sends" in result) props.onCommit(result.sends ?? null);
  };
  leave.current = commit;
  const pending = "sends" in result ? result.sends : undefined;
  const onPending = useRef(props.onPending);
  onPending.current = props.onPending;
  useEffect(() => {
    onPending.current?.(pending);
  }, [pending]);
  useEffect(() => () => onPending.current?.(undefined), []);
  const describedBy = useRowHint(props.describedBy);
  return (
    <input
      id={props.id}
      aria-label={props.label}
      type="text"
      inputMode={props.min < 0 ? "text" : "numeric"}
      enterKeyHint="done"
      value={draft}
      placeholder={props.placeholder}
      disabled={props.disabled}
      readOnly={props.unavailable}
      aria-disabled={props.unavailable && !props.disabled ? true : undefined}
      aria-describedby={describedBy}
      onFocus={focus.onFocus}
      onChange={(e) => {
        setDraft(e.target.value);
        // Told in the keystroke's own update as well as by the effect above, which reached the form a moment later: a press right after typing saw the form without the number.
        const next = numberCommit(e.target.value, props);
        props.onPending?.("sends" in next ? next.sends : undefined);
      }}
      onBlur={() => {
        if (focus.onBlur()) commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") focus.discard(e.currentTarget);
      }}
      style={{ ...fieldStyle({ disabled: props.disabled || props.unavailable }), width: props.width ?? NUMBER_FIELD_WIDTH, textAlign: props.align, fontVariantNumeric: "tabular-nums" }}
    />
  );
}

export function Select<T extends string>(props: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  label: string;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <FieldSelect
      id={props.id}
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value as T)}
      style={{ flex: 1, minWidth: 0, width: "100%", maxWidth: "100%" }}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </FieldSelect>
  );
}

const BUTTON_VARIANT = { default: "secondary", primary: "primary", danger: "danger" } as const;

export function SmallButton(props: {
  ref?: Ref<HTMLButtonElement>;
  /** Optional for a submit button, whose form handles the press. */
  onClick?(): void;
  /** None for an icon alone, whose `label` is its name and its tooltip. */
  children?: ReactNode;
  icon?: IconName;
  label?: string;
  tone?: "default" | "primary" | "danger";
  /** A `danger` button waiting for its second tap (components/Button.tsx). */
  armed?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  /**
   * Disabled to the eye and to a screen reader (`aria-disabled`), where a
   * press does nothing, but still focusable: for a button that turns
   * unavailable as it is pressed, such as the known form just taken, whose
   * native `disabled` would drop the keyboard's focus to the page
   * (features/measure/controls.tsx OptButton).
   */
  unavailable?: boolean;
  grow?: boolean;
  type?: "button" | "submit";
  /** A long label that wraps inside the button, which grows taller, where a line is narrower than it. */
  wrap?: boolean;
}) {
  const { onClick } = props;
  const variant = BUTTON_VARIANT[props.tone ?? "default"];
  return (
    <Button
      ref={props.ref}
      size="sm"
      variant={variant}
      type={props.type ?? "button"}
      onClick={onClick && !props.unavailable ? () => onClick() : undefined}
      aria-label={props.label}
      title={props.label}
      icon={props.icon}
      iconOnly={props.icon && props.children === undefined ? "always" : undefined}
      pressed={props.pressed}
      armed={props.armed}
      disabled={props.disabled}
      aria-disabled={props.unavailable || undefined}
      style={{
        flex: props.grow ? 1 : "none",
        ...(props.wrap ? { minWidth: 0, maxWidth: "100%", whiteSpace: "normal", textAlign: "center" } : { whiteSpace: "nowrap" }),
        ...(props.unavailable ? { ...buttonLook(variant, { pressed: props.pressed, disabled: true }), cursor: "default" } : null),
      }}
    >
      {props.children}
    </Button>
  );
}

/** − value + with the value itself editable, for elevation and counters. */
export function Stepper(props: {
  value: number;
  onChange(value: number): void;
  step: number;
  min: number;
  max: number;
  label: string;
  unit?: string;
  disabled?: boolean;
}) {
  const set = (n: number) => {
    const next = Math.min(props.max, Math.max(props.min, n));
    if (next !== props.value) props.onChange(next);
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: theme.space(1) }}>
      <SmallButton label={`${props.label} minus ${props.step}`} onClick={() => set(props.value - props.step)} disabled={props.disabled}>
        −{props.step}
      </SmallButton>
      <DraftNumber
        label={props.label}
        value={props.value}
        min={props.min}
        max={props.max}
        disabled={props.disabled}
        onCommit={(n) => n !== null && set(n)}
        width={76}
        align="center"
      />
      {props.unit ? <span style={{ color: theme.color.textMuted, fontSize: theme.font.small }}>{props.unit}</span> : null}
      <SmallButton label={`${props.label} plus ${props.step}`} onClick={() => set(props.value + props.step)} disabled={props.disabled}>
        +{props.step}
      </SmallButton>
    </div>
  );
}

/**
 * A button that asks once more before it acts, for deletes. `busy` is a
 * delete that waits for the server, which ignores further taps.
 * `describedBy` names what the delete takes with it, in both states, so a
 * screen reader hears it with "Tap again to delete" too. `wrap` lets a
 * long label, such as a character's name, wrap inside the button and
 * break inside a long word, where a line is narrower than it.
 */
export function ConfirmButton(props: {
  onConfirm(): void;
  children: ReactNode;
  confirm: string;
  label?: string;
  grow?: boolean;
  busy?: boolean;
  describedBy?: string;
  wrap?: boolean;
  icon?: IconName;
  /** The icon alone until armed, then the icon and the confirm words (docs/design-v1-icons.md 3.1 rule 6). */
  iconOnly?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  const label = armed ? props.confirm : props.label;
  return (
    <Button
      size="sm"
      variant="danger"
      armed={armed}
      busy={props.busy}
      icon={props.icon}
      iconOnly={props.iconOnly && !armed ? "always" : undefined}
      aria-label={label}
      aria-describedby={props.describedBy}
      title={label}
      onClick={() => {
        if (armed) {
          setArmed(false);
          props.onConfirm();
        } else setArmed(true);
      }}
      style={{
        flex: props.grow ? 1 : "none",
        ...(props.wrap ? { minWidth: 0, maxWidth: "100%", whiteSpace: "normal", overflowWrap: "anywhere", textAlign: "center" } : { whiteSpace: "nowrap" }),
      }}
    >
      {armed ? props.confirm : props.children}
    </Button>
  );
}

const NOTE_COLOR = { muted: undefined, info: theme.color.text, error: theme.color.dangerText } as const;

/**
 * A short line under a control, in the Help look: muted by default, in
 * text color for `info` (a result or a fact worth reading, which used to
 * wear the turn's cream highlight), or an error in `dangerText`, which
 * reads 5.9:1 on a surface where `danger` read 4.2:1. Not the warning
 * tone: these lines say what happened as often as what it costs, and a
 * caller that means a caution uses Panel.tsx's Note.
 */
export function Note(props: { children: ReactNode; tone?: "muted" | "error" | "info" }) {
  const color = NOTE_COLOR[props.tone ?? "muted"];
  return <Help style={color ? { color } : undefined}>{props.children}</Help>;
}
